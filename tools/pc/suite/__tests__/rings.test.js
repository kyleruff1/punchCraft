/**
 * The ring check, on records shaped as the app writes them. The round's work
 * clock starts at 10 000 on the page's clock; a bar of two rings is due at
 * work 4 000 and 4 500.
 */
import { RING_LATE_WARN_MS, ringReport, ringVerdict } from '../rings.mjs'

const WORK = 10_000
const at = (monoMs, code, fields) => ({
  wallMs: 0,
  monoMs,
  level: 'info',
  args: [`[INFO] ${code}`, 'message', fields],
})
const boundary = at(WORK, 'workout.round.boundary', {
  transition: 'work-entered',
  roundIndex: 0,
  workElapsedMs: 0,
  monotonicTimeMs: WORK,
})
/** The loop reaching a ring's time: logged 40 ms after it, as the 50 ms loop does. */
const due = (cueId, ordinal, scheduledMs, roundIndex = 0) =>
  at(WORK + scheduledMs + 40, 'workout.cue.tokenDue', {
    roundIndex,
    cueId,
    ordinal,
    tokenIndex: ordinal,
    scheduledMs,
    workElapsedMs: scheduledMs + 40,
    monotonicTimeMs: WORK + scheduledMs + 40,
  })
/** The ring being painted `lateMs` after its time. */
const painted = (cueId, ordinal, scheduledMs, lateMs = 5) =>
  at(WORK + scheduledMs + lateMs, 'workout.ring.visual', { cueId, ordinal })
const viz = (records, monoMs = WORK + 100) =>
  at(monoMs, 'workout.viz.batch', { count: records.length, records: JSON.stringify(records) })
const token = (cueId, tokenIndex, workElapsedMs) => ({
  kind: 'token',
  cueId,
  tokenIndex,
  ordinal: tokenIndex,
  source: 'token-due',
  workElapsedMs,
  monotonicMs: WORK + workElapsedMs,
})
const end = at(WORK + 60_000, 'workout.round.boundary', {
  transition: 'rest-entered',
  roundIndex: 0,
  monotonicTimeMs: WORK + 60_000,
})
const bar = (cueId, startMs) => [due(cueId, 0, startMs), due(cueId, 1, startMs + 500)]
const run = (...records) =>
  [boundary, viz([token('a', 0, 4_040)]), ...records.flat(), end].sort(
    (a, b) => a.monoMs - b.monoMs,
  )

describe('ringReport', () => {
  it('counts a bar whose rings all lit, and says how late they were painted', () => {
    const report = ringReport(
      run(
        bar('a', 4_000),
        painted('a', -1, 4_000),
        painted('a', 0, 4_000, 5),
        painted('a', 1, 4_500, 9),
      ),
    )
    expect(report).toMatchObject({ bars: 1, rings: 2, lit: 2, unlit: [], skipped: [], late: [] })
    expect(report.paintedLate).toMatchObject({ n: 2, minMs: 5, maxMs: 9 })
    expect(ringVerdict(report)).toEqual({ verdict: 'PASS', hard: [], soft: [] })
  })

  it('fails a bar that never reached its last ring', () => {
    const report = ringReport(run(bar('a', 4_000), painted('a', 0, 4_000)))
    expect(report.unlit).toEqual([{ cueId: 'a', reached: 0, expected: 1 }])
    expect(ringVerdict(report).hard).toEqual([
      '1 bar(s) did not light all their rings — first: a reached ring 1 of 2',
    ])
    // A bar the walk never painted at all is the same failure.
    expect(ringReport(run(bar('a', 4_000))).unlit).toEqual([
      { cueId: 'a', reached: -1, expected: 1 },
    ])
  })

  it('warns on a ring a late frame stepped over', () => {
    const report = ringReport(run(bar('a', 4_000), painted('a', 1, 4_500)))
    expect(report).toMatchObject({ unlit: [], skipped: [{ cueId: 'a', ordinal: 0 }] })
    expect(ringVerdict(report)).toMatchObject({
      verdict: 'WARN',
      soft: ['1 ring(s) were stepped over by a late frame — first: ring 1 of a'],
    })
  })

  it('warns on a ring painted long after its time, against the schedule and not the loop’s log', () => {
    const late = RING_LATE_WARN_MS + 30
    const report = ringReport(
      run(bar('a', 4_000), painted('a', 0, 4_000, late), painted('a', 1, 4_500)),
    )
    expect(report.late).toEqual([{ cueId: 'a', ordinal: 0, lateMs: late }])
    expect(ringVerdict(report).soft[0]).toMatch(
      /1 ring\(s\) were painted more than 100 ms after their time — worst: ring 1 of a, 130 ms/,
    )
  })

  it('does not ask for a ring whose time came as the capture ended', () => {
    const report = ringReport(
      [boundary, viz([token('a', 0, 4_040)]), due('a', 0, 59_900), end].sort(
        (a, b) => a.monoMs - b.monoMs,
      ),
    )
    expect(report).toMatchObject({ bars: 0, unlit: [] })
  })
})

describe('round by round, and the app’s loop', () => {
  it('gives the lateness round by round', () => {
    const second = [
      at(WORK + 120_000, 'workout.round.boundary', {
        transition: 'work-entered',
        roundIndex: 1,
        workElapsedMs: 0,
        monotonicTimeMs: WORK + 120_000,
      }),
      at(WORK + 124_040, 'workout.cue.tokenDue', {
        roundIndex: 1,
        cueId: 'b',
        ordinal: 0,
        scheduledMs: 4_000,
        workElapsedMs: 4_040,
        monotonicTimeMs: WORK + 124_040,
      }),
      at(WORK + 124_006, 'workout.ring.visual', { cueId: 'b', ordinal: 0 }),
      at(WORK + 180_000, 'workout.round.boundary', {
        transition: 'rest-entered',
        roundIndex: 1,
        monotonicTimeMs: WORK + 180_000,
      }),
    ]
    const report = ringReport(
      run(bar('a', 4_000), painted('a', 0, 4_000, 50), painted('a', 1, 4_500, 52), second),
    )
    expect(report.paintedLateByRound.map((r) => [r.roundIndex, r.medianMs])).toEqual([
      [0, 52],
      [1, 6],
    ])
  })

  it('warns when the loop stalled and caught up — and says it is the loop, not the rings', () => {
    const records = [
      token('a', 0, 4_040),
      token('a', 0, 4_040),
      {
        kind: 'clock',
        workDeltaMs: 900,
        wallDeltaMs: 900,
        workElapsedMs: 5_000,
        monotonicMs: WORK + 5_000,
      },
    ]
    const report = ringReport([
      boundary,
      viz(records),
      ...bar('a', 4_000),
      painted('a', 0, 4_000),
      painted('a', 1, 4_500),
      end,
    ])
    expect(report.loop).toMatchObject({ relight: 1, stalls: 1 })
    expect(ringVerdict(report).soft[0]).toMatch(
      /the app’s loop stalled and caught up: 1 stall\(s\).*not the painted rings/,
    )
  })

  it('does not take the work clock starting again at a new round for a stall', () => {
    const rollover = {
      kind: 'clock',
      workDeltaMs: -239_989,
      wallDeltaMs: 65,
      workElapsedMs: 10,
      monotonicMs: WORK + 300_000,
    }
    const report = ringReport([
      boundary,
      viz([token('a', 0, 4_040), rollover]),
      ...bar('a', 4_000),
      painted('a', 0, 4_000),
      painted('a', 1, 4_500),
      end,
    ])
    expect(report.loop.stalls).toBe(0)
    expect(ringVerdict(report).verdict).toBe('PASS')
  })

  it('warns when there are no forensics records to read', () => {
    const report = ringReport([
      boundary,
      ...bar('a', 4_000),
      painted('a', 0, 4_000),
      painted('a', 1, 4_500),
      end,
    ])
    expect(ringVerdict(report).soft).toEqual([
      'the app logged no forensics records, so its loop could not be checked',
    ])
  })
})
