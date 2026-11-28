/**
 * The ring check on a device capture.
 *
 * The same check as the PC's, fed from `logcat.txt` — and a logcat can lose
 * lines, which a page's records cannot. The tablet's September captures lose
 * two to four ring records in a workout. So here a ring with no record is
 * only unlit when the app itself says so; a missing record the app's own
 * word contradicts is a lost line.
 *
 * Every capture below is built as page records and written out with the PC
 * suite's own `logcatText`, so the two adapters are held to the same input.
 */
import { ringReportFromLogcat, ringVerdict } from '../../../analysis/rings.mjs'
import { logcatText } from '../capture.mjs'
import { ringReport } from '../rings.mjs'

const WORK = 10_000
/** A record whose log line is stamped when it was written, as a device's is. */
const at = (monoMs, code, fields) => ({
  wallMs: monoMs,
  monoMs,
  level: 'info',
  args: [`[INFO] ${code}`, 'message', fields],
})
const opened = at(WORK, 'workout.round.boundary', {
  transition: 'work-entered',
  roundIndex: 0,
  workElapsedMs: 0,
  monotonicTimeMs: WORK,
})
const closed = at(WORK + 60_000, 'workout.round.boundary', {
  transition: 'rest-entered',
  roundIndex: 0,
  monotonicTimeMs: WORK + 60_000,
})
const due = (cueId, ordinal, scheduledMs) =>
  at(WORK + scheduledMs + 40, 'workout.cue.tokenDue', {
    roundIndex: 0,
    cueId,
    ordinal,
    tokenIndex: ordinal,
    scheduledMs,
    workElapsedMs: scheduledMs + 40,
    monotonicTimeMs: WORK + scheduledMs + 40,
  })
const forensic = (cueId, ordinal, scheduledMs) =>
  at(WORK + scheduledMs + 41, 'workout.viz.batch', {
    count: 1,
    records: JSON.stringify([
      {
        kind: 'token',
        cueId,
        tokenIndex: ordinal,
        ordinal,
        source: 'token-due',
        workElapsedMs: scheduledMs + 40,
        monotonicMs: WORK + scheduledMs + 40,
      },
    ]),
  })
/** A ring step from a build that says which frame lit it: the frame 4 ms after its time, the line 30 ms after. */
const step = (
  cueId,
  ordinal,
  scheduledMs,
  { from = ordinal - 1, row = 'lit', frameLate = 4 } = {},
) =>
  at(WORK + scheduledMs + 30, 'workout.ring.visual', {
    cueId,
    ordinal,
    from,
    workElapsedMs: scheduledMs + frameLate - 1,
    frameMs: WORK + scheduledMs + frameLate,
    row,
  })
/** The same step from a build before that: a bar and a ring, and nothing else. */
const bareStep = (cueId, ordinal, scheduledMs, lineLate = 30) =>
  at(WORK + scheduledMs + lineLate, 'workout.ring.visual', { cueId, ordinal })
const promoted = (cueId, scheduledMs, previousCueId, previousReached) =>
  at(WORK + scheduledMs + 29, 'workout.ring.promote', {
    cueId,
    lateMs: 3,
    previousCueId,
    previousReached,
    frameMs: WORK + scheduledMs + 4,
  })

/** Two bars of three rings: `a` at work 4 000, `b` at 6 000, a ring every 500 ms. */
const BARS = [
  ['a', 4_000],
  ['b', 6_000],
]
const schedule = BARS.flatMap(([cueId, start]) =>
  [0, 1, 2].flatMap((ordinal) => [
    due(cueId, ordinal, start + ordinal * 500),
    forensic(cueId, ordinal, start + ordinal * 500),
  ]),
)
const steps = BARS.flatMap(([cueId, start]) =>
  [0, 1, 2].map((ordinal) => step(cueId, ordinal, start + ordinal * 500)),
)
const promotions = [promoted('a', 4_000, '', -1), promoted('b', 6_000, 'a', 2)]
const capture = (records) => [opened, ...records, closed].sort((x, y) => x.monoMs - y.monoMs)
const whole = () => capture([...schedule, ...steps, ...promotions])
const without = (records, match) => records.filter((r) => !match(r))
const isStep = (cueId, ordinal) => (r) =>
  r.args[0] === '[INFO] workout.ring.visual' &&
  r.args[2].cueId === cueId &&
  r.args[2].ordinal === ordinal
const fromDevice = (records) => ringReportFromLogcat(logcatText(records))

describe('the same capture, through either door', () => {
  it('gives the same report from a page’s records and from the logcat written from them', () => {
    const page = ringReport(whole())
    const device = fromDevice(whole())
    for (const key of [
      'bars',
      'rings',
      'lit',
      'unlit',
      'skipped',
      'late',
      'paintedLate',
      'paintedLateByRound',
      'stamped',
      'ringClockLate',
      'ringClockSkewByRound',
      'rows',
      'promotedLate',
      'loop',
    ]) {
      expect(device[key]).toEqual(page[key])
    }
    expect(page.capture).toBe('page')
    expect(device.capture).toBe('logcat')
    expect(device).toMatchObject({
      bars: 2,
      rings: 6,
      lit: 6,
      stamped: 6,
      absent: [],
      lineLoss: { ringSteps: 0, tokenDue: 0, forensics: 0 },
    })
    expect(ringVerdict(device)).toEqual({ verdict: 'PASS', hard: [], soft: [] })
  })
})

describe('a log that lost a line', () => {
  it('does not call a ring stepped over when the next step says it came from it', () => {
    // The record of a's second ring never reached the log. The third ring's
    // step says it came from the second: the ring lit, the line was lost.
    const report = fromDevice(without(whole(), isStep('a', 1)))
    expect(report.skipped).toEqual([])
    expect(report.unlit).toEqual([])
    expect(report.absent).toEqual([])
    expect(report.lit).toBe(6)
    expect(report.lineLoss.ringSteps).toBe(1)
    expect(ringVerdict(report).verdict).toBe('PASS')
  })

  it('does not call a bar unlit when the bar after it says how far it got', () => {
    // a's LAST ring has no record. The promotion of b says a reached it.
    const report = fromDevice(without(whole(), isStep('a', 2)))
    expect(report.unlit).toEqual([])
    expect(report.absent).toEqual([])
    expect(report.lineLoss.ringSteps).toBe(1)
    expect(ringVerdict(report).verdict).toBe('PASS')
  })

  it('counts the lines it can prove were lost: a ring token logged once where the app logs it twice', () => {
    const lost = (r) =>
      r.args[0] === '[INFO] workout.cue.tokenDue' &&
      r.args[2].cueId === 'b' &&
      r.args[2].ordinal === 1
    const report = fromDevice(without(whole(), lost))
    expect(report.lineLoss).toMatchObject({ tokenDue: 1, forensics: 0 })
  })
})

describe('a ring that really did not light', () => {
  it('fails a bar the app itself says was left before its last ring — on a device too', () => {
    const records = capture([
      ...schedule,
      ...without(steps, isStep('a', 2)),
      promoted('a', 4_000, '', -1),
      promoted('b', 6_000, 'a', 1),
    ])
    const report = fromDevice(records)
    expect(report.unlit).toEqual([{ cueId: 'a', reached: 1, expected: 2 }])
    expect(ringVerdict(report).hard).toEqual([
      '1 bar(s) did not light all their rings — first: a reached ring 2 of 3',
    ])
  })

  it('warns, with the step that jumped, when a frame stepped over a ring', () => {
    // b's third ring was stepped to from its first: the second was never lit.
    const jumped = [
      ...without(steps, (r) => isStep('b', 1)(r) || isStep('b', 2)(r)),
      step('b', 2, 7_000, { from: 0 }),
    ]
    const report = fromDevice(capture([...schedule, ...jumped, ...promotions]))
    expect(report.skipped).toEqual([{ cueId: 'b', ordinal: 1 }])
    expect(report.lineLoss.ringSteps).toBe(0)
    expect(ringVerdict(report).soft).toEqual([
      '1 ring(s) were stepped over by a late frame — first: ring 2 of b',
    ])
  })
})

describe('a capture from a build before the records said anything', () => {
  // September's tablet captures: a bar and a ring per step, no clock, no
  // `from`, and a promotion that names only its own bar.
  const bare = () =>
    capture([
      ...schedule,
      ...BARS.flatMap(([cueId, start]) =>
        [0, 1, 2].map((ordinal) => bareStep(cueId, ordinal, start + ordinal * 500)),
      ),
    ])

  it('never judges a log line’s time as the ring’s', () => {
    // 150 ms after the ring's time is when the LINE was written, a thread-hop
    // and a queue after the frame. On a PC that would be a late ring.
    const slow = capture([
      ...schedule,
      ...BARS.flatMap(([cueId, start]) =>
        [0, 1, 2].map((ordinal) => bareStep(cueId, ordinal, start + ordinal * 500, 150)),
      ),
    ])
    const report = fromDevice(slow)
    expect(report.late).toEqual([])
    expect(report.paintedLate.n).toBe(0)
    expect(report.stamped).toBe(0)
    expect(report.recordLate).toMatchObject({ n: 6, medianMs: 150 })
    expect(ringVerdict(report).verdict).toBe('PASS')
    // The same records on a page are timed by the page's own stamp, as ever.
    expect(ringReport(slow).late).toHaveLength(6)
  })

  it('only asks about a bar whose last rings have no record — it cannot know', () => {
    const records = without(bare(), isStep('a', 2))
    const report = fromDevice(records)
    expect(report.unlit).toEqual([])
    expect(report.absent).toEqual([{ cueId: 'a', reached: 1, expected: 2 }])
    const verdict = ringVerdict(report)
    expect(verdict.verdict).toBe('WARN')
    expect(verdict.soft[0]).toMatch(
      /1 bar\(s\) have no record of their last rings lighting — first: a, recorded to ring 2 of 3/,
    )
    expect(verdict.soft[0]).toMatch(/cannot say whether these are lost lines or unlit rings/)
    // A page loses nothing, so there the same silence is the answer.
    expect(ringVerdict(ringReport(records)).verdict).toBe('FAIL')
  })

  it('does not call a ring stepped over on a device when nothing says how it was passed', () => {
    const report = fromDevice(without(bare(), isStep('b', 1)))
    expect(report.skipped).toEqual([])
    expect(ringReport(without(bare(), isStep('b', 1))).skipped).toEqual([
      { cueId: 'b', ordinal: 1 },
    ])
  })
})
