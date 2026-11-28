/**
 * The walkout, the rest line and the countdown are held to the manifest.
 *
 * A manifest said what each round should play and nothing about what is said
 * around the rounds. The app logs each of those as it builds it; this checks
 * the line it logs, and that the thing was started.
 *
 * Fixtures are in the real ConsoleSink shape. The clock: the walkout is
 * loaded at 09:59:30 and plays from 09:59:35; round 1 opens at 10:00:00 and
 * runs 60 s; the rest runs 30 s; round 2 opens at 10:01:30 and runs 60 s.
 */
import { ceremonyHealth, ceremoniesText, judgeCeremonies, parseCeremonyRecord, renderCeremonies } from '../ceremonies.mjs'
import { verify } from '../verify-first-round.mjs'

const NL = String.fromCharCode(10)
const line = (time, tag, body) => `11-28 ${time} I/${tag}( 8286): ${body}`
const recordOn = (tag) => (time, code, fields, message = 'message') => {
  const [first, ...rest] = Object.entries(fields).map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : v}`)
  return [line(time, tag, `'[INFO] ${code}', '${message}', { ${first},`), ...rest.map((f) => line(time, tag, `  ${f},`)), line(time, tag, '}')].join(NL)
}
const record = recordOn('ReactNativeJS')
/** `seconds` after 10:00:00, as a log time; negative is before it. */
const at = (seconds) => {
  const total = 10 * 3600 + seconds
  const whole = Math.floor(total)
  const ms = Math.round((total - whole) * 1000)
  const two = (n) => String(n).padStart(2, '0')
  return `${two(Math.floor(whole / 3600))}:${two(Math.floor((whole % 3600) / 60))}:${two(whole % 60)}.${String(ms).padStart(3, '0')}`
}

const OPENERS = { 'warn-opener-01': 2000, 'warn-opener-02': 3100 }
const MANIFEST = {
  formatVersion: 2,
  workoutId: 'two-rounds',
  workoutName: 'Two Rounds',
  bpm: 120,
  identity: { workoutId: 'two-rounds', revision: 1, timelineHash: 'v2:abcd' },
  ceremonies: {
    walkout: { segments: ['intro-hello', 'intro-program', 'lead', 'intro-letsgo'], plannedMs: 24_020, tracks: 7 },
    countdownOpeners: OPENERS,
  },
  rounds: [
    {
      roundIndex: 0,
      workDurationMs: 60_000,
      restAfterMs: 30_000,
      coachEvents: [],
      expectedCallBars: 2,
      rest: {
        restLine: { scriptId: 'rr-aaaa1111', slot: 'rest/two-rounds/r1', text: 'Shake it out.', plannedMs: 12_855, tracks: 1 },
        // A theme, a lead-in and "round 2", each after a 350 ms breath.
        countdown: { round: 2, afterOpener: ['theme', 'lead', 'warn-round-2'], afterOpenerMs: 12_548, tracks: 7 },
      },
    },
    { roundIndex: 1, workDurationMs: 60_000, restAfterMs: 0, coachEvents: [], expectedCallBars: 2, rest: null },
  ],
}

const boundary = (seconds, transition, roundIndex) => record(at(seconds), 'workout.round.boundary', { transition, roundIndex, workElapsedMs: 0 })
const provenance = record('09:59:20.000', 'workout.timeline.provenance', { workout: 'two-rounds', timelineHash: 'v2:abcd', path: 'click' })
const call = (seconds) => record(at(seconds), 'workout.clickScript.dispatch', { kind: 'call', slot: 'call/1-2', dispatchAtMs: 1000 })

const walkoutLoaded = (over = {}) => record(at(-30), 'workout.intro', { segments: 4, plannedMs: 24_020, tracks: 7, boundaries: 6, ...over }, 'intro loaded')
const walkoutPlaying = record(at(-25), 'workout.intro', { plannedMs: 24_020, playId: 'intro-1' }, 'intro playing')
const restLoaded = (over = {}) => record(at(60.02), 'workout.recovery', { scriptId: 'rr-aaaa1111', segments: 1, plannedMs: 12_855, tracks: 1, boundaries: 0, ...over }, 'recovery loaded')
const restPlaying = record(at(61.1), 'workout.recovery', { scriptId: 'rr-aaaa1111', restElapsedMs: 1100, playId: 'recovery-2' }, 'recovery playing')
const countdownPrepared = (over = {}) =>
  record(at(60.01), 'workout.warn', { round: 2, opener: 'warn-opener-02', totalMs: 15_648, plannedMs: 15_648, tracks: 7, boundaries: 6, ...over }, 'round warning prepared')
const countdownPlaying = record(at(74), 'workout.warn', { round: 2, remainingMs: 15_755, totalMs: 15_648, playId: 'warn-3' }, 'round warning playing')

/** A whole capture of both rounds; `parts` replaces any of the ceremony lines. */
const capture = (parts = {}) => {
  const p = {
    walkoutLoaded: walkoutLoaded(),
    walkoutPlaying,
    restLoaded: restLoaded(),
    restPlaying,
    countdownPrepared: countdownPrepared(),
    countdownPlaying,
    round2: [boundary(90, 'work-entered', 1), call(95), call(100), boundary(150, 'completed', 1)],
    extra: [],
    ...parts,
  }
  return [
    provenance,
    p.walkoutLoaded,
    p.walkoutPlaying,
    boundary(0, 'work-entered', 0),
    call(5),
    call(10),
    boundary(60, 'rest-entered', 0),
    p.countdownPrepared,
    p.restLoaded,
    p.restPlaying,
    p.countdownPlaying,
    ...p.extra,
    ...p.round2,
    '',
  ]
    .filter((part) => part !== null)
    .join(NL)
}
const states = (result) => result.ceremonies.map((c) => [c.kind, c.state])

describe('a capture in which every ceremony was built as planned and started', () => {
  it('matches all three, and passes', () => {
    const r = verify(MANIFEST, capture())
    expect(states(r)).toEqual([
      ['walkout', 'matched'],
      ['rest-line', 'matched'],
      ['countdown', 'matched'],
    ])
    expect(r.health).toMatchObject({ verdict: 'PASS', ceremoniesJudged: 3, ceremoniesMatched: 3 })
  })

  it('takes whichever opener the countdown drew, and subtracts its length', () => {
    // Opener 01 is 1,100 ms shorter than 02, and so is the whole countdown.
    const r = verify(MANIFEST, capture({ countdownPrepared: countdownPrepared({ opener: 'warn-opener-01', totalMs: 14_548, plannedMs: 14_548 }) }))
    expect(states(r)[2]).toEqual(['countdown', 'matched'])
  })
})

describe('a ceremony that was built wrong fails the capture', () => {
  it('a rest that loaded another script', () => {
    const r = verify(MANIFEST, capture({ restLoaded: restLoaded({ scriptId: 'rr-bbbb2222' }) }))
    const rest = r.ceremonies[1]
    expect(rest).toMatchObject({ kind: 'rest-line', roundIndex: 0, state: 'mismatch' })
    expect(rest.problems).toEqual(['scriptId: rr-bbbb2222, where the manifest says rr-aaaa1111'])
    expect(r.health).toMatchObject({ verdict: 'FAIL', hardFail: true, ceremoniesMismatched: 1 })
  })

  it('a countdown that lost its lead-in: two tracks and its length short', () => {
    const r = verify(MANIFEST, capture({ countdownPrepared: countdownPrepared({ totalMs: 11_000, tracks: 5 }) }))
    expect(r.ceremonies[2].state).toBe('mismatch')
    expect(r.ceremonies[2].problems).toEqual([
      'tracks: 5, where the manifest says 7',
      "length after the opener: 7900 ms (11000 less warn-opener-02's 3100), where the manifest says 12548",
    ])
    expect(r.health.verdict).toBe('FAIL')
  })

  it('a countdown for the wrong round, or with an opener the manifest does not know', () => {
    expect(verify(MANIFEST, capture({ countdownPrepared: countdownPrepared({ round: 3 }) })).ceremonies[2].problems).toEqual(['round: 3, where the manifest says 2'])
    const unknown = verify(MANIFEST, capture({ countdownPrepared: countdownPrepared({ opener: 'warn-opener-99' }) }))
    expect(unknown.ceremonies[2].problems[0]).toMatch(/warn-opener-99, which is not one of the 2/)
  })

  it('a walkout with a clip missing', () => {
    const r = verify(MANIFEST, capture({ walkoutLoaded: walkoutLoaded({ segments: 3, plannedMs: 19_000, tracks: 5 }) }))
    expect(r.ceremonies[0]).toMatchObject({ kind: 'walkout', roundIndex: null, state: 'mismatch' })
    expect(r.ceremonies[0].problems).toHaveLength(3)
    expect(r.health.verdict).toBe('FAIL')
  })

  it('judges the build that played: one made earlier and replaced is not it', () => {
    // The walkout is loaded in the lobby and can be loaded again before it plays.
    const first = record(at(-40), 'workout.intro', { segments: 3, plannedMs: 19_000, tracks: 5, boundaries: 4 }, 'intro loaded')
    const r = verify(MANIFEST, capture({ walkoutLoaded: [first, walkoutLoaded()].join(NL) }))
    expect(r.ceremonies[0].state).toBe('matched')
  })
})

describe('a ceremony with no line, or never started', () => {
  const noRestLine = { restLoaded: null, restPlaying: null }

  it('warns on a device, whose log drops lines', () => {
    const r = verify(MANIFEST, capture(noRestLine))
    expect(r.ceremonies[1]).toMatchObject({ state: 'absent', problems: ['no line for it in the capture'] })
    expect(r.health).toMatchObject({ verdict: 'WARN', ceremoniesMissing: 1 })
  })

  it('fails on a PC capture, which loses nothing', () => {
    const web = capture(noRestLine).replaceAll('I/ReactNativeJS(', 'I/PunchCraftWeb(')
    expect(verify(MANIFEST, web).health).toMatchObject({ verdict: 'FAIL', hardFail: true })
  })

  it('fails on a device too when the app itself logged that the playlist failed', () => {
    const failed = record(at(60.03), 'workout.recovery', { scriptId: 'rr-aaaa1111', error: 'Error: boom' }, 'playlist creation failed').replace('[INFO]', '[WARN]')
    const r = verify(MANIFEST, capture({ ...noRestLine, extra: [failed] }))
    expect(r.ceremonies[1]).toMatchObject({ state: 'absent', appSaidFailed: true })
    expect(r.health.verdict).toBe('FAIL')
  })

  it('is “built, never started” when only the start is missing', () => {
    const r = verify(MANIFEST, capture({ countdownPlaying: null }))
    expect(r.ceremonies[2]).toMatchObject({ state: 'not-started', problems: ['built, and never started'] })
    expect(r.health.verdict).toBe('WARN')
  })
})

describe('a rest the capture does not hold whole', () => {
  it('is not judged: a countdown is not due until the rest’s last seconds', () => {
    // A round-1 drive on the tablet stops at the first rest.
    const r = verify(MANIFEST, capture({ round2: [], countdownPlaying: null, restPlaying: null }))
    expect(states(r)).toEqual([
      ['walkout', 'matched'],
      ['rest-line', 'unjudged'],
      ['countdown', 'unjudged'],
    ])
    expect(r.health).toMatchObject({ verdict: 'PASS', ceremoniesJudged: 1, ceremoniesMatched: 1 })
  })

  it('is judged when the next round only opened: the rest is whole', () => {
    // The default PC drive stops three seconds into round 2.
    const r = verify(MANIFEST, capture({ round2: [boundary(90, 'work-entered', 1), call(92)] }))
    expect(states(r).map(([, state]) => state)).toEqual(['matched', 'matched', 'matched'])
  })
})

describe('what is not held to anything', () => {
  it('a rest with no authored script: the walkthrough is reported, not checked', () => {
    const manifest = structuredClone(MANIFEST)
    manifest.rounds[0].rest.restLine = null
    const r = verify(manifest, capture({ restLoaded: restLoaded({ scriptId: 'R07' }) }))
    expect(r.ceremonies[1]).toMatchObject({ state: 'unchecked', observed: { scriptId: 'R07' } })
    expect(r.health.verdict).toBe('PASS')
  })

  it('a field the line does not carry: a build from before it was logged', () => {
    // `tracks` joined the countdown's line in September. A line without it is
    // older, not wrong — and its length is still checked.
    const older = countdownPrepared().split(NL).filter((l) => !l.includes('tracks:')).join(NL)
    expect(verify(MANIFEST, capture({ countdownPrepared: older })).ceremonies[2].state).toBe('matched')
    const shorter = older.replace('totalMs: 15648', 'totalMs: 15000')
    expect(verify(MANIFEST, capture({ countdownPrepared: shorter })).ceremonies[2].state).toBe('mismatch')
  })

  it('a manifest from before ceremonies had expectations', () => {
    const { ceremonies: _ceremonies, ...old } = MANIFEST
    const r = verify(old, capture({ restLoaded: restLoaded({ scriptId: 'rr-bbbb2222' }) }))
    expect(r.ceremonies).toEqual([])
    expect(r.health.verdict).toBe('PASS')
    expect(r.health.ceremoniesJudged).toBeUndefined()
  })

  it('a capture that cannot be tied to the manifest’s timeline: a wrong line can only warn', () => {
    const stale = capture({ restLoaded: restLoaded({ scriptId: 'rr-bbbb2222' }) }).replace("timelineHash: 'v2:abcd'", "timelineHash: 'v2:ffff'")
    const r = verify(MANIFEST, stale)
    expect(r.ceremonies[1].state).toBe('mismatch')
    expect(r.health.verdict).toBe('STALE')
  })
})

describe('parseCeremonyRecord', () => {
  it('reads each ceremony’s lines, and nothing else', () => {
    expect(parseCeremonyRecord("'[INFO] workout.intro', 'intro loaded', { segments: 4, plannedMs: 24020, tracks: 7, boundaries: 6 }", 5)).toEqual({ type: 'intro.loaded', ts: 5, segments: 4, plannedMs: 24_020, tracks: 7 })
    expect(parseCeremonyRecord("'[INFO] workout.recovery', 'recovery playing', { scriptId: 'rr-1', restElapsedMs: 1103 }", 6)).toEqual({ type: 'recovery.playing', ts: 6, scriptId: 'rr-1' })
    expect(parseCeremonyRecord("'[WARN] workout.warn', 'round warning play failed', { round: 2 }", 7)).toEqual({ type: 'ceremony.failed', ts: 7, tag: 'workout.warn' })
    expect(parseCeremonyRecord("'[INFO] workout.voice.observed', 'coach play observed', { label: 'intro' }", 8)).toBeNull()
  })
})

describe('ceremonyHealth and the report', () => {
  const rounds = [
    { t0Ts: 100_000, endTs: 160_000 },
    { t0Ts: 190_000, endTs: 250_000 },
  ]
  const events = [
    { type: 'intro.loaded', ts: 70_000, segments: 4, plannedMs: 24_020, tracks: 7 },
    { type: 'intro.playing', ts: 75_000 },
    { type: 'warn.prepared', ts: 160_010, round: 2, opener: 'warn-opener-02', totalMs: 15_648, tracks: 7 },
    { type: 'recovery.loaded', ts: 160_020, scriptId: 'rr-bbbb2222', plannedMs: 12_855, tracks: 1 },
    { type: 'recovery.playing', ts: 161_000, scriptId: 'rr-bbbb2222' },
  ]
  const verdicts = judgeCeremonies(events, MANIFEST, rounds)

  it('counts what was judged, matched, wrong and missing', () => {
    expect(ceremonyHealth(verdicts, { lossless: false, suppressed: false })).toEqual({
      ceremoniesDescribed: 3,
      ceremoniesJudged: 3,
      ceremoniesMatched: 1,
      ceremoniesMismatched: 1,
      ceremoniesMissing: 1,
      hard: true,
      soft: false,
    })
  })

  it('names each ceremony, says what the app built, and lists what read wrong', () => {
    const md = renderCeremonies(verdicts).join(NL)
    expect(md).toContain('| walkout | as planned | segments 4 · plannedMs 24020 · tracks 7 |')
    expect(md).toContain('| rest line after round 1 | **not what the manifest says** | scriptId rr-bbbb2222 · plannedMs 12855 · tracks 1 |')
    expect(md).toContain('| countdown into round 2 | **built, never started** |')
    expect(md).toContain('- **rest line after round 1** — scriptId: rr-bbbb2222, where the manifest says rr-aaaa1111')
    expect(renderCeremonies([])).toEqual([])
  })

  it('gives the suites one phrase for a summary cell', () => {
    expect(ceremoniesText({ health: { ceremoniesDescribed: 7, ceremoniesJudged: 7, ceremoniesMatched: 7 } })).toBe('7 of 7 ceremonies')
    expect(ceremoniesText({ health: { verdict: 'PASS' } })).toBe('')
    expect(ceremoniesText(null)).toBe('')
  })
})
