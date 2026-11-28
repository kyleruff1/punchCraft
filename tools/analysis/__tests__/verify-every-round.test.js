/**
 * The correlator judges every round a manifest describes.
 *
 * It judged round 1 and stopped. Rounds after the first were only ever
 * checked for sounding whole; nothing said what they should have played. A
 * manifest can now hold every round, and each is judged against its own part
 * — but only when the capture holds it whole, and never silently fewer than
 * the drive was meant to complete.
 *
 * Fixtures are in the real ConsoleSink shape. The clock: round 1 opens at
 * 10:00:00, runs 60 s, rests 30 s; round 2 opens at 10:01:30 and runs 60 s.
 */
import { manifestRounds, verify } from '../verify-first-round.mjs'

const NL = String.fromCharCode(10)
const line = (time, body) => `11-28 ${time} I/ReactNativeJS( 8286): ${body}`
const record = (time, code, fields, message = 'message') => {
  const [first, ...rest] = Object.entries(fields).map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : v}`)
  return [line(time, `'[INFO] ${code}', '${message}', { ${first},`), ...rest.map((f) => line(time, `  ${f},`)), line(time, '}')].join(NL)
}
/** `seconds` after 10:00:00, as a log time. */
const at = (seconds) => {
  const whole = Math.floor(seconds)
  const ms = Math.round((seconds - whole) * 1000)
  return `10:${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}
const boundary = (seconds, transition, roundIndex) => record(at(seconds), 'workout.round.boundary', { transition, roundIndex, workElapsedMs: 0 })
const provenance = record('09:59:50.000', 'workout.timeline.provenance', { workout: 'two-rounds', timelineHash: 'v2:abcd', path: 'click' })
/** A lead-in clip heard `seconds` after 10:00:00. */
const leadIn = (seconds, text) => record(at(seconds), 'workout.voice.play', { kind: 'click-script', text, durationMs: 2000 }, 'click-script playing')
const call = (seconds) => record(at(seconds), 'workout.clickScript.dispatch', { kind: 'call', slot: 'call/1-2', dispatchAtMs: 1000 })
const calls = (from, n) => Array.from({ length: n }, (_, i) => call(from + 1 + i * 2))
const token = (seconds, roundIndex, workElapsedMs) => record(at(seconds), 'workout.cue.tokenDue', { roundIndex, cueId: 'c', ordinal: 0, workElapsedMs })

const R1 = 0
const R1_END = 60
const R2 = 90
const R2_END = 150

const MANIFEST = {
  formatVersion: 2,
  workoutId: 'two-rounds',
  workoutName: 'Two Rounds',
  bpm: 120,
  identity: { workoutId: 'two-rounds', revision: 1, timelineHash: 'v2:abcd' },
  rounds: [
    {
      roundIndex: 0,
      workDurationMs: 60_000,
      coachEvents: [{ kind: 'lead-in', slot: 'lead-in/two-rounds/r1s2', text: 'Round one, section two.', durationMs: 2000, expectedStartMs: 20_000 }],
      expectedCallBars: 10,
    },
    {
      roundIndex: 1,
      workDurationMs: 60_000,
      coachEvents: [{ kind: 'lead-in', slot: 'lead-in/two-rounds/r2s2', text: 'Round two, section two.', durationMs: 2000, expectedStartMs: 30_000 }],
      expectedCallBars: 12,
    },
  ],
}

const round1 = ({ callCount = 10, leadInAt = 20 } = {}) => [boundary(R1, 'work-entered', 0), ...calls(R1, callCount), ...(leadInAt === null ? [] : [leadIn(R1 + leadInAt, 'Round one, section two.')]), boundary(R1_END, 'rest-entered', 0)]
const round2 = ({ callCount = 12, leadInAt = 30, opening = true, closing = 'completed' } = {}) => [
  ...(opening ? [boundary(R2, 'work-entered', 1)] : []),
  token(R2 + 5, 1, 5_000),
  token(R2 + 10, 1, 10_000),
  ...calls(R2, callCount),
  ...(leadInAt === null ? [] : [leadIn(R2 + leadInAt, 'Round two, section two.')]),
  ...(closing ? [boundary(R2_END, closing, 1)] : []),
]
const capture = (...parts) => [provenance, ...parts.flat(), ''].join(NL)

describe('manifestRounds', () => {
  it('reads a manifest that holds every round', () => {
    expect(manifestRounds(MANIFEST).map((r) => r.roundIndex)).toEqual([0, 1])
  })

  it('reads a manifest from before that as round 1 alone', () => {
    const old = { roundIndex: 0, workDurationMs: 240_000, coachEvents: [{ kind: 'lead-in' }], expectedCallBars: 78 }
    expect(manifestRounds(old)).toEqual([{ roundIndex: 0, workDurationMs: 240_000, coachEvents: [{ kind: 'lead-in' }], expectedCallBars: 78 }])
  })
})

describe('a capture of both rounds', () => {
  const result = () => verify(MANIFEST, capture(round1(), round2()))

  it('judges each round against its own part of the manifest', () => {
    const r = result()
    expect(r.rounds.map((round) => [round.roundIndex, round.state, round.health.verdict])).toEqual([
      [0, 'judged', 'PASS'],
      [1, 'judged', 'PASS'],
    ])
    expect(r.rounds[0].health).toMatchObject({ matched: 1, callsDispatched: 10, callsExpected: 10 })
    expect(r.rounds[1].health).toMatchObject({ matched: 1, callsDispatched: 12, callsExpected: 12 })
  })

  it('places a round’s events from that round’s own bell', () => {
    // Round 2's lead-in is 30 s into round 2 — 120 s into the capture.
    const second = result().verdicts.find((v) => v.roundIndex === 1)
    expect(second).toMatchObject({ verdict: 'matched' })
    expect(Math.round(second.observed.elapsedMs)).toBe(30_000)
  })

  it('reports the capture as a whole: counts added up, the verdict the worst', () => {
    const r = result()
    expect(r.health).toMatchObject({ verdict: 'PASS', matched: 2, total: 2, callsDispatched: 22, callsExpected: 22, callCoveragePct: 100 })
    expect(r).toMatchObject({ roundsDescribed: 2, roundsJudged: 2 })
    expect(r.dispatcher).toMatchObject({ callsDispatched: 22, expectedCallBars: 22 })
  })

  it('fails the capture for a lead-in missing from round 2 alone', () => {
    const r = verify(MANIFEST, capture(round1(), round2({ leadInAt: null })))
    expect(r.rounds[0].health.verdict).toBe('PASS')
    expect(r.rounds[1].health).toMatchObject({ verdict: 'FAIL', missing: 1 })
    expect(r.health).toMatchObject({ verdict: 'FAIL', missing: 1, matched: 1 })
  })

  it('fails it for a round 2 in which no call was made', () => {
    const r = verify(MANIFEST, capture(round1(), round2({ callCount: 0 })))
    expect(r.rounds[1].health).toMatchObject({ noCalls: true, verdict: 'FAIL' })
    expect(r.health.verdict).toBe('FAIL')
  })

  it('does not count round 2’s calls toward round 1', () => {
    const r = verify(MANIFEST, capture(round1({ callCount: 8 }), round2()))
    expect(r.rounds[0].health).toMatchObject({ callsDispatched: 8, callCoveragePct: 80, lowCalls: true, verdict: 'WARN' })
    expect(r.rounds[1].health.callsDispatched).toBe(12)
  })
})

describe('a round the capture does not hold whole', () => {
  it('is opened, not judged, when the capture ends inside it', () => {
    // The default PC drive stops three seconds into round 2.
    const r = verify(MANIFEST, capture(round1(), round2({ closing: null, leadInAt: null, callCount: 1 })))
    expect(r.rounds.map((round) => round.state)).toEqual(['judged', 'opened'])
    expect(r.health.verdict).toBe('PASS')
    expect(r).toMatchObject({ roundsJudged: 1, roundsDescribed: 2 })
  })

  it('is absent when the capture never reached it', () => {
    const r = verify(MANIFEST, capture(round1()))
    expect(r.rounds.map((round) => round.state)).toEqual(['judged', 'absent'])
    expect(r.health.verdict).toBe('PASS')
  })

  it('fails the run when the drive was meant to complete it', () => {
    // Otherwise a check of every round quietly becomes a check of one.
    const short = capture(round1(), round2({ closing: null, leadInAt: null, callCount: 1 }))
    const r = verify(MANIFEST, short, { expectRounds: 2 })
    expect(r.health).toMatchObject({ verdict: 'FAIL', hardFail: true, roundsNotJudged: [1] })
    expect(r.roundsExpected).toBe(2)
    // Meant to complete one, and it did: no failure.
    expect(verify(MANIFEST, short, { expectRounds: 1 }).health.verdict).toBe('PASS')
  })

  it('never expects more rounds than the manifest describes', () => {
    const r = verify(MANIFEST, capture(round1(), round2()), { expectRounds: 9 })
    expect(r.roundsExpected).toBe(2)
    expect(r.health.verdict).toBe('PASS')
  })
})

describe('where a later round begins and ends', () => {
  it('ends the last round on `completed`: it has no rest', () => {
    const r = verify(MANIFEST, capture(round1(), round2({ closing: 'completed' })))
    expect(r.rounds[1].state).toBe('judged')
  })

  it('ends a round that has a rest on its own `rest-entered`', () => {
    const r = verify(MANIFEST, capture(round1(), round2({ closing: 'rest-entered' })))
    expect(r.rounds[1].state).toBe('judged')
  })

  it('places a round by its ring tokens when its `work-entered` line was lost', () => {
    // Logcat drops lines. Each ring token carries the work clock's reading,
    // so the round began that long before it.
    const r = verify(MANIFEST, capture(round1(), round2({ opening: false })))
    expect(r.rounds[1].state).toBe('judged')
    expect(r.rounds[1].t0.source).toMatch(/cue\.tokenDue/)
    expect(r.rounds[1].health).toMatchObject({ verdict: 'PASS', matched: 1, callsDispatched: 12 })
  })
})

describe('more calls than the plan holds', () => {
  it('is a warning: the manifest and the build disagree about the round', () => {
    // The expected number is the runner's own plan, so the runner cannot
    // exceed it. Before the manifest was that plan, 20 of 44 runs did, read
    // as "105 %", and passed (N-20).
    const r = verify(MANIFEST, capture(round1({ callCount: 11 }), round2()))
    expect(r.rounds[0].health).toMatchObject({ callsDispatched: 11, callsExpected: 10, moreCallsThanPlanned: true, verdict: 'WARN' })
    expect(r.health.verdict).toBe('WARN')
  })
})

describe('a manifest that describes one round', () => {
  const old = { workoutId: 'two-rounds', workoutName: 'Two Rounds', roundIndex: 0, workDurationMs: 60_000, bpm: 120, identity: MANIFEST.identity, coachEvents: MANIFEST.rounds[0].coachEvents, expectedCallBars: 10, strikes: [] }

  it('is judged as it always was, with a rounds list of one beside it', () => {
    const r = verify(old, capture(round1(), round2()))
    expect(r.health).toMatchObject({ verdict: 'PASS', matched: 1, callsDispatched: 10, callsExpected: 10 })
    expect(r.rounds).toHaveLength(1)
    expect(r.rounds[0].health).toBe(r.health)
    // Its verdict rows are the round's own, untagged.
    expect(r.verdicts[0].roundIndex).toBeUndefined()
  })
})
