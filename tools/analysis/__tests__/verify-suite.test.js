/**
 * Guards for the unattended suite driver (GH #292, plan B3): the pure parts
 * — URL and device-shell quoting, budget math, the volume and AudioTrack
 * parsers, verdict aggregation, the GitHub ledger row — plus the observed
 * summary it prints beside every verdict.
 */

import {
  aggregateVerdicts,
  buildRefusal,
  appendLedgerRow,
  budgetMs,
  buildRunUrl,
  closerThan,
  compactStats,
  END_SLACK_MS,
  findLoopIssue,
  launchIntentArgs,
  ledgerRows,
  parseArgs,
  parseAudioTrackReading,
  parseCompactStats,
  parseVolumeGet,
  planJobs,
  quoteForDeviceShell,
  runQuery,
  sameCommit,
  isEmulatorDevice,
  renderSummaryMd,
  ringGateVerdict,
  ringsCell,
  timingRefusal,
  timingVerdictFromExit,
  verdictFromVerifyExit,
  WALKOUT_ALLOWANCE_MS,
  workAxisLines,
  worstVerdict,
} from '../verify-suite.mjs'
import { latencyStats, summarizeObserved } from '../observed-summary.mjs'

describe('run URL', () => {
  it('carries every QA param and autostart, URL-encoded — and never asks to enable QA mode', () => {
    const url = buildRunUrl({ workout: 'quick-one-two', vocab: 'techniques', sim: 'captured-jam', simForce: true, simBpm: 120, nonce: 'suite 1' })
    expect(url).toBe(
      'punchcraft://qa/run?workout=quick-one-two&vocab=techniques&sim=captured-jam&simForce=1&simBpm=120&autostart=1&nonce=suite%201',
    )
  })

  it('is the shared query behind the tablet’s scheme — the PC suite opens the same query as a page', () => {
    const run = { workout: 'body-work', vocab: 'numbers', sim: 'captured-jam', nonce: 'n-1' }
    expect(runQuery(run)).toBe('workout=body-work&vocab=numbers&sim=captured-jam&autostart=1&nonce=n-1')
    expect(buildRunUrl(run)).toBe(`punchcraft://qa/run?${runQuery(run)}`)
  })

  it('quotes for the device shell so & does not fork, and never leaks a single quote', () => {
    expect(quoteForDeviceShell('punchcraft://qa/run?a=1&b=2')).toBe("'punchcraft://qa/run?a=1&b=2'")
    expect(quoteForDeviceShell("x'y")).toBe("'x%27y'")
  })

  it('builds the scheme-resolved intent, never a component name', () => {
    const argv = launchIntentArgs('punchcraft://qa/run?a=1&b=2', 'serial-1')
    expect(argv).toEqual([
      '-s', 'serial-1', 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d',
      "'punchcraft://qa/run?a=1&b=2'", 'com.kyleruff.punchcraft',
    ])
    expect(argv.join(' ')).not.toContain('-n ')
  })
})

describe('budget', () => {
  const quick = { scheduleMs: [{ workMs: 240_000, restMs: 60_000 }, { workMs: 240_000, restMs: 0 }], workDurationMs: 240_000 }
  it('sums walkout + every work and rest + slack for a full session', () => {
    expect(budgetMs(quick)).toBe(WALKOUT_ALLOWANCE_MS + 540_000 + END_SLACK_MS)
  })
  it('caps a first-round-only drive at round 1', () => {
    expect(budgetMs(quick, { firstRoundOnly: true })).toBe(WALKOUT_ALLOWANCE_MS + 240_000 + END_SLACK_MS)
  })
  it('falls back to workDurationMs for a manifest without the session shape', () => {
    expect(budgetMs({ workDurationMs: 180_000 })).toBe(WALKOUT_ALLOWANCE_MS + 180_000 + END_SLACK_MS)
  })
})

describe('device parsers', () => {
  it('reads the media_session volume line as printed on the tablet', () => {
    const text = '[V] will control stream=3 (STREAM_MUSIC)\n[V] will get volume\n[V] Connecting to AudioService\n[V] volume is 13 in range [0..15]\n'
    expect(parseVolumeGet(text)).toEqual({ level: 13, min: 0, max: 15 })
    expect(parseVolumeGet('garbage')).toBeNull()
  })
  it('reads one audiotrack-count.sh line', () => {
    expect(parseAudioTrackReading('14:02:11  ours=12   others=3    system=15   pid=1234    at-arm')).toEqual({ ours: 12, others: 3, system: 15, pid: 1234 })
    expect(parseAudioTrackReading('app not running (com.kyleruff.punchcraft)')).toBeNull()
  })
})

describe('verdicts', () => {
  it('maps the verifier exit codes', () => {
    expect([0, 2, 1, 4, 3, null].map(verdictFromVerifyExit)).toEqual(['PASS', 'WARN', 'FAIL', 'STALE', 'ERROR', 'ERROR'])
  })
  it('aggregates: FAIL/ERROR → 1, STALE → 4, WARN → 2, else 0', () => {
    expect(aggregateVerdicts(['PASS', 'PASS'])).toBe(0)
    expect(aggregateVerdicts(['PASS', 'WARN'])).toBe(2)
    expect(aggregateVerdicts(['WARN', 'STALE'])).toBe(4)
    expect(aggregateVerdicts(['STALE', 'FAIL'])).toBe(1)
    expect(aggregateVerdicts(['ERROR'])).toBe(1)
    expect(aggregateVerdicts([])).toBe(0)
  })

  it('stages the timing gate: the same hard finding warns, then fails', () => {
    // Exit 1 from the analyzer is `barsAtOrPastPunch` — a call still
    // sounding at the punch. Under `warn` (the default) it must not block a
    // suite, or the baseline run this gate needs can never be collected.
    expect(timingVerdictFromExit(1, 'warn')).toBe('WARN')
    expect(timingVerdictFromExit(1, 'fail')).toBe('FAIL')
    expect(timingVerdictFromExit(2, 'fail')).toBe('WARN')
    expect(timingVerdictFromExit(0, 'fail')).toBe('PASS')
  })

  it('never fails a drive because the ANALYZER broke', () => {
    // Exit 3 is "no session / could not read the capture" and any other code
    // is a crash. That is a broken instrument, not a broken coach: capping it
    // at WARN keeps a bad logcat from failing a drive that may have been
    // perfect. `off` and a missing exit judge nothing at all.
    expect(timingVerdictFromExit(3, 'fail')).toBe('WARN')
    expect(timingVerdictFromExit(99, 'fail')).toBe('WARN')
    expect(timingVerdictFromExit(1, 'off')).toBe('PASS')
    expect(timingVerdictFromExit(null, 'fail')).toBe('PASS')
    expect(timingVerdictFromExit(undefined, 'warn')).toBe('PASS')
  })

  it('lets the timing verdict only make a drive worse', () => {
    expect(worstVerdict('PASS', 'WARN')).toBe('WARN')
    expect(worstVerdict('FAIL', 'WARN')).toBe('FAIL')
    expect(worstVerdict('STALE', 'WARN')).toBe('STALE')
    expect(worstVerdict('WARN', 'FAIL')).toBe('FAIL')
    // A clean timing report cannot rescue a drive the correlator failed.
    expect(worstVerdict('FAIL', 'PASS')).toBe('FAIL')
    expect(worstVerdict('STALE', 'PASS')).toBe('STALE')
  })
})

describe('args', () => {
  it('defaults the timing gate to fail and rejects anything else', () => {
    // Staging is over. `warn` established the baseline (41 calls at or past
    // the punch across 24 drives); `fail` is what keeps it from coming back.
    expect(parseArgs(['--all']).timingGate).toBe('fail')
    expect(parseArgs(['--all', '--timing-gate=warn']).timingGate).toBe('warn')
    expect(parseArgs(['--all', '--timing-gate=off']).timingGate).toBe('off')
    expect(() => parseArgs(['--all', '--timing-gate=yes'])).toThrow(/--timing-gate/)
  })
})

describe('summary rendering', () => {
  const meta = { suiteId: '1', deviceId: 'dev', launch: 'cold', vocab: 'numbers', sim: 'captured-jam', firstRoundOnly: false, timingGate: 'warn', exitCode: 2 }

  it('separates the never-late cell from the comfort-floor cell', () => {
    // These are different questions with different severities, and a single
    // combined cell would let the eye slide past the one that is a defect.
    const md = renderSummaryMd(
      [
        {
          workoutId: 'quick-six-count',
          vocab: 'numbers',
          verdict: 'WARN',
          verifyExit: 0,
          timingExit: 2,
          timingVerdict: 'WARN',
          breathFloor: { minBreathMs: 56.7, p5BreathMs: 118.7, barsAtOrPastPunch: 0, barsUnderFloor: 12, n: 85, barsUnderFloorRatio: 0.141 },
          elapsedMs: 1000,
        },
      ],
      meta,
    )
    expect(md).toContain('| 56.7 / 118.7 | 0 | 12/85 (14.1%) |')
    expect(md).toContain('timing gate warn')
  })

  it('names the workout behind every hard timing finding', () => {
    // A count in a ledger nobody can act on is a number, not a gate.
    const md = renderSummaryMd(
      [{ workoutId: 'body-work', vocab: 'numbers', verdict: 'WARN', timingVerdict: 'WARN', timingExit: 1, timingHard: ['1 bar(s) with the call still sounding at the punch'], breathFloor: null, elapsedMs: 0 }],
      meta,
    )
    expect(md).toContain('### Timing — hard findings')
    expect(md).toContain('**body-work (numbers)** — 1 bar(s) with the call still sounding at the punch')
  })

  it('renders a drive that has no timing report at all', () => {
    // `--timing-gate=off`, or a launch failure with no round to analyze.
    const md = renderSummaryMd([{ workoutId: 'body-work', vocab: 'numbers', verdict: 'ERROR', reason: 'launch timeout', elapsedMs: 0 }], { ...meta, timingGate: 'off' })
    expect(md).toContain('| body-work | numbers | ERROR | launch timeout | — | — | — | — | — |')
    expect(md).not.toContain('### Timing — hard findings')
  })
})

describe('ledger', () => {
  const report = {
    verdicts: [{ status: 'matched' }, { status: 'matched' }, { status: 'late' }, { status: 'missing' }],
    extras: [{}, {}],
    reanchorCount: 7,
  }
  const TEMPLATE = [
    '## Context',
    '',
    '**Workout id**: `body-work`',
    '',
    '## Test-drive results',
    '',
    '| Drive | Timestamp | Commit | Verdict | Top mismatches | Closer? |',
    '|---|---|---|---|---|---|',
    '',
    '## Analysis',
    '_Per-drive summary._',
  ].join('\n')

  it('compacts a verify report to stats the next row can parse back', () => {
    const stats = compactStats(report)
    expect(stats).toBe('late=1 matched=2 missing=1 extras=2 reanchor=7')
    expect(parseCompactStats(stats)).toEqual({ late: 1, matched: 2, missing: 1, extras: 2, reanchor: 7 })
  })

  it('computes Closer? from the mismatch total, ignoring matched/extras/reanchor', () => {
    expect(closerThan(null, { late: 1 })).toBe('first')
    expect(closerThan({ late: 2, missing: 1, matched: 5 }, { late: 1, matched: 3, reanchor: 99 })).toBe('closer')
    expect(closerThan({ late: 1 }, { late: 1, missing: 1 })).toBe('farther')
    expect(closerThan({ late: 1, extras: 9 }, { late: 1 })).toBe('same')
  })

  it('appends numbered rows under the table header, Closer? from the previous row', () => {
    const once = appendLedgerRow(TEMPLATE, { timestamp: '2026-09-07 21:00', sha: 'abc1234', verdict: 'WARN', stats: 'late=2 matched=2 extras=0 reanchor=3' })
    expect(ledgerRows(once)).toEqual(['| 1 | 2026-09-07 21:00 | abc1234 | WARN | late=2 matched=2 extras=0 reanchor=3 | first |'])
    const twice = appendLedgerRow(once, { timestamp: '2026-09-07 22:00', sha: 'def5678', verdict: 'PASS', stats: 'matched=4 extras=0 reanchor=1' })
    expect(ledgerRows(twice)).toHaveLength(2)
    expect(ledgerRows(twice)[1]).toBe('| 2 | 2026-09-07 22:00 | def5678 | PASS | matched=4 extras=0 reanchor=1 | closer |')
    // The rest of the body is untouched.
    expect(twice).toContain('## Analysis\n_Per-drive summary._')
    expect(twice.split('## Test-drive results')).toHaveLength(2)
  })

  it('refuses a body without the table', () => {
    expect(() => appendLedgerRow('## Context only', { timestamp: 't', sha: 's', verdict: 'PASS', stats: '' })).toThrow(/no Test-drive results table/)
  })

  it('finds the LOOP issue by its Workout id line, not its title', () => {
    const issues = [
      { number: 302, title: '[LOOP] Body Work — first-round audio verification', body: TEMPLATE },
      { number: 999, title: '[LOOP] quick-one-two', body: '**Workout id**: `quick-one-two`' },
    ]
    expect(findLoopIssue(issues, 'body-work')?.number).toBe(302)
    expect(findLoopIssue(issues, 'quick-one-two')?.number).toBe(999)
    expect(findLoopIssue(issues, 'body')).toBeNull()
  })
})

describe('job planning', () => {
  const files = ['body-work.json', 'body-work.techniques.json', 'heavy-hands.json', 'heavy-hands.techniques.json', 'quick-jab-school.json']
  it('lists every numeric manifest once, sorted', () => {
    expect(planJobs(files, { vocab: 'numbers' }).map((j) => j.workoutId)).toEqual(['body-work', 'heavy-hands', 'quick-jab-school'])
  })
  it('--vocab=both doubles each workout, numbers first', () => {
    const jobs = planJobs(['body-work.json', 'body-work.techniques.json'], { vocab: 'both' })
    expect(jobs.map((j) => `${j.workoutId}/${j.vocab}/${j.dirName}`)).toEqual(['body-work/numbers/body-work', 'body-work/techniques/body-work.techniques'])
  })
  it('--only filters and names a missing manifest', () => {
    expect(planJobs(files, { only: ['heavy-hands'], vocab: 'numbers' })).toHaveLength(1)
    expect(() => planJobs(files, { only: ['nope'], vocab: 'numbers' })).toThrow(/no manifest for: nope/)
    expect(() => planJobs(files, { only: ['quick-jab-school'], vocab: 'techniques' })).toThrow(/no techniques manifest/)
  })
})

describe('args', () => {
  it('derives the launch mode from --expect-release', () => {
    expect(parseArgs(['--all']).launch).toBe('warm')
    expect(parseArgs(['--all', '--expect-release']).launch).toBe('cold')
    expect(parseArgs(['--all', '--launch=cold']).launch).toBe('cold')
  })
  it('takes --require-sha bare (this checkout) or with a commit id, and nothing else', () => {
    expect(parseArgs(['--all']).requireSha).toBeUndefined()
    expect(parseArgs(['--all', '--require-sha']).requireSha).toBe('HEAD')
    expect(parseArgs(['--all', '--require-sha=8a080194']).requireSha).toBe('8a080194')
    expect(() => parseArgs(['--all', '--require-sha=main'])).toThrow(/--require-sha/)
    expect(() => parseArgs(['--all', '--require-sha=abc'])).toThrow(/--require-sha/)
  })
  it('takes --part: one of several processes sharing a run folder', () => {
    expect(parseArgs(['--all']).part).toBe(false)
    expect(parseArgs(['--only=body-work', '--part']).part).toBe(true)
  })
  it('rejects a run with nothing selected, a bad vocab, or an unknown flag', () => {
    expect(() => parseArgs([])).toThrow(/--all or --only/)
    expect(() => parseArgs(['--all', '--vocab=loud'])).toThrow(/--vocab/)
    expect(() => parseArgs(['--all', '--wat'])).toThrow(/unknown argument/)
  })
})

describe('observed summary', () => {
  const PID = '( 8286)'
  // The REAL ConsoleSink shape, copied from a device capture:
  //   '[INFO] workout.voice.play', 'clip playing', { asset: 'bell',
  // The level is what sits in the brackets; the event code follows it. A
  // fixture written as '[<code>] …' passes against a matcher built the same
  // wrong way and finds nothing in the field — that is exactly what happened
  // on the first release drive, so this helper is the shape contract.
  const rec = (time, tag, fields) => {
    const entries = Object.entries(fields)
    const [first, ...rest] = entries
    const fmt = (v) => (typeof v === 'string' ? `'${v}'` : String(v))
    return [
      `08-31 ${time} I/ReactNativeJS${PID}: '[INFO] ${tag}', 'message', { ${first[0]}: ${fmt(first[1])},`,
      ...rest.map(([k, v]) => `08-31 ${time} I/ReactNativeJS${PID}:   ${k}: ${fmt(v)},`),
      `08-31 ${time} I/ReactNativeJS${PID}: }`,
    ].join('\n')
  }

  it('parses a line copied verbatim from a device capture', () => {
    const real = [
      "09-07 15:10:43.596 I/ReactNativeJS(15660): '[INFO] workout.voice.observed', 'clip observed', { playId: 'ab12-1',",
      '09-07 15:10:43.596 I/ReactNativeJS(15660):   kind: \'click-script\',',
      '09-07 15:10:43.596 I/ReactNativeJS(15660):   outcome: \'ok\',',
      '09-07 15:10:43.596 I/ReactNativeJS(15660):   onsetLatencyMs: 12,',
      '09-07 15:10:43.596 I/ReactNativeJS(15660):   observedDurationMs: 1000,',
      '09-07 15:10:43.596 I/ReactNativeJS(15660):   expectedDurationMs: 1000,',
      '09-07 15:10:43.596 I/ReactNativeJS(15660):   silentByVolume: false }',
    ].join('\n')
    const s = summarizeObserved(real)
    expect(s.present).toBe(true)
    expect(s.byKind['click-script']).toMatchObject({ n: 1, outcomes: { ok: 1 } })
    expect(s.byKind['click-script'].onset.medianMs).toBe(12)
  })

  it('does not confuse a code with one that extends it', () => {
    const blocked = rec('10:00:00.000', 'workout.qa.run.blocked', { workout: 'body-work', nonce: 'n1' })
    const staged = rec('10:00:01.000', 'workout.qa.run', { workout: 'body-work', dev: false, nonce: 'n1' })
    const { recordsWithTag } = require('../logcat.mjs')
    expect(recordsWithTag(`${blocked}\n${staged}`, 'workout.qa.run')).toHaveLength(1)
    expect(recordsWithTag(`${blocked}\n${staged}`, 'workout.qa.run')[0].body).toContain('dev: false')
    expect(recordsWithTag(`${blocked}\n${staged}`, 'workout.qa.run.blocked')).toHaveLength(1)
  })

  it('reports coverage, per-kind onset stats, truncation, silent births and the instrument tap', () => {
    const text = [
      rec('10:00:01.000', 'workout.voice.play', { asset: 'a', playId: 'ab12-1' }),
      rec('10:00:01.100', 'workout.voice.observed', { playId: 'ab12-1', kind: 'click-script', path: 'armed', outcome: 'ok', onsetLatencyMs: 12, observedDurationMs: 900, expectedDurationMs: 1000, silentByVolume: false }),
      rec('10:00:02.000', 'workout.voice.play', { asset: 'b', playId: 'ab12-2' }),
      rec('10:00:02.100', 'workout.voice.observed', { playId: 'ab12-2', kind: 'click-script', path: 'fresh', outcome: 'ok', onsetLatencyMs: 40, observedDurationMs: 1000, expectedDurationMs: 1000, silentByVolume: true }),
      rec('10:00:03.000', 'workout.voice.play', { asset: 'c', playId: 'ab12-3' }),
      rec('10:00:03.100', 'workout.voice.observed', { playId: 'intro-1', kind: 'intro', outcome: 'released', onsetLatencyMs: 30, observedDurationMs: 500, expectedDurationMs: 9000, silentByVolume: false }),
      rec('10:00:04.000', 'workout.instrument.observed', { eventId: 'e1', outcome: 'ok', latencyMs: 1.1, pipelineMs: 4 }),
      rec('10:00:04.010', 'workout.instrument.observed', { eventId: 'e2', outcome: 'masked', latencyMs: null, pipelineMs: 4 }),
      rec('10:00:05.000', 'workout.observer.stats', { watched: 3, openAtRelease: 0, maxHandlerMs: 0.4 }),
    ].join('\n')
    const s = summarizeObserved(text)
    expect(s.present).toBe(true)
    expect(s.playsWithId).toBe(3)
    expect(s.voiceObserved).toBe(3)
    // Three plays, but only two of them were observed — the third observation
    // is the INTRO, a ceremony that mints its own playId and writes no
    // `voice.play`. Counting it toward coverage hid the missing play (and
    // produced "1/0 plays" on a capture that was all ceremony).
    expect(s.coverage).toBeCloseTo(2 / 3, 3)
    expect(s.ceremonyObserved).toBe(1)
    expect(s.byKind['click-script']).toMatchObject({ n: 2, outcomes: { ok: 2 }, truncated: 0, silentBirths: 1 })
    expect(s.byKind['click-script'].onset).toEqual({ n: 2, medianMs: 26, p95Ms: 40, jitterMs: 14 })
    expect(s.byKind['click-script'].byPath.armed.medianMs).toBe(12)
    expect(s.byKind.intro).toMatchObject({ n: 1, outcomes: { released: 1 } })
    expect(s.instrument).toMatchObject({ n: 2, outcomes: { ok: 1, masked: 1 }, maskedRatio: 0.5, busyRatio: 0 })
    expect(s.instrument.latency.medianMs).toBe(1.1)
    expect(s.observer).toEqual({ watched: 3, openAtRelease: 0, maxHandlerMs: 0.4 })
  })

  it('counts a play cut short of its planned length as truncated', () => {
    const text = rec('10:00:01.100', 'workout.voice.observed', { playId: 'x', kind: 'clip', outcome: 'ok', onsetLatencyMs: 5, observedDurationMs: 600, expectedDurationMs: 1000, silentByVolume: false })
    expect(summarizeObserved(text).byKind.clip.truncated).toBe(1)
  })

  it('is honest about a capture with no observer records', () => {
    const s = summarizeObserved('08-31 10:00:00.000 I/ReactNativeJS( 1): \'[workout.voice.play] clip playing\', { asset: \'a\' }')
    expect(s).toMatchObject({ present: false, playsWithId: 0, coverage: null, voiceObserved: 0 })
  })

  it('latencyStats ignores non-numbers and reports jitter as p95 − median', () => {
    expect(latencyStats([10, undefined, 20, null, 30, 100])).toEqual({ n: 4, medianMs: 25, p95Ms: 100, jitterMs: 75 })
    expect(latencyStats([])).toEqual({ n: 0, medianMs: null, p95Ms: null, jitterMs: null })
  })
})

describe('an emulator is a PC (findings doc, N-19)', () => {
  // 2026-11-27: this suite ran the timing analyzer on an emulator's capture,
  // and it proposed CALL_DISPATCH_LAG_MS 71 → 28 from this PC's audio path.

  describe('asking the device', () => {
    it('knows an emulator by the name adb gives it', () => {
      expect(isEmulatorDevice({ serial: 'emulator-5556' })).toBe(true)
      expect(isEmulatorDevice({ serial: 'emulator-5554', qemu: '', characteristics: '' })).toBe(true)
    })

    it('knows one by its own properties, whatever it is called', () => {
      expect(isEmulatorDevice({ serial: '192.0.2.10:5555', qemu: '1' + String.fromCharCode(13, 10) })).toBe(true)
      expect(isEmulatorDevice({ serial: '192.0.2.10:5555', characteristics: 'emulator' })).toBe(true)
      expect(isEmulatorDevice({ serial: '192.0.2.10:5555', characteristics: 'tablet,emulator' })).toBe(true)
    })

    it('leaves a tablet a tablet', () => {
      expect(isEmulatorDevice({ serial: '192.0.2.10:5555', qemu: '', characteristics: 'tablet,nosdcard' })).toBe(false)
      expect(isEmulatorDevice({ serial: 'ABC123XYZ', qemu: '0', characteristics: 'tablet' })).toBe(false)
      expect(isEmulatorDevice({ serial: 'my-emulator-5556-lookalike' })).toBe(false)
      expect(isEmulatorDevice({})).toBe(false)
      expect(isEmulatorDevice()).toBe(false)
    })
  })

  describe('whether timing is judged', () => {
    it('is, on the tablet’s own capture', () => {
      expect(timingRefusal({ platform: 'android', deviceIsEmulator: false })).toBeNull()
    })

    it('is not, when the capture says an emulator wrote it', () => {
      expect(timingRefusal({ platform: 'android-emulator', deviceIsEmulator: false })).toMatch(/emulator/)
    })

    it('is not, when the device is an emulator and the build is too old to say so', () => {
      // A September release APK installed to test an upgrade carries no field.
      expect(timingRefusal({ platform: 'android', deviceIsEmulator: true })).toMatch(/emulator/)
    })

    it('is not, for a PC capture', () => {
      expect(timingRefusal({ platform: 'web', deviceIsEmulator: false })).toMatch(/written on "web", not on the tablet/)
    })
  })

  describe('what is shown in its place', () => {
    const P = '08-31 10:00:00.000 I/ReactNativeJS( 8286): '
    const rec = (tag, fields) => {
      const [first, ...rest] = Object.entries(fields).map(([k, v]) => k + ': ' + (typeof v === 'string' ? "'" + v + "'" : String(v)))
      return [P + "'[INFO] " + tag + "', 'message', { " + first + ',', ...rest.map((f) => P + '  ' + f + ','), P + '}'].join(NEWLINE)
    }
    const NEWLINE = String.fromCharCode(10)
    const capture = [
      rec('workout.round.boundary', { transition: 'work-entered', roundIndex: 0, workElapsedMs: 0, monotonicTimeMs: 10012 }),
      rec('workout.cue.tokenDue', { roundIndex: 0, cueId: 'a#0', combination: '1-2', tokenIndex: 0, ordinal: 0, workElapsedMs: 5000, monotonicTimeMs: 15000, scheduledMs: 4990 }),
      rec('workout.cue.tokenDue', { roundIndex: 0, cueId: 'a#0', combination: '1-2', tokenIndex: 1, ordinal: 1, workElapsedMs: 6000, monotonicTimeMs: 16000, scheduledMs: 5995 }),
    ].join(NEWLINE)

    it('gives the work axis: the app’s two clocks, round by round', () => {
      expect(workAxisLines(capture)).toEqual(['round 0: 2 ring tokens place the work clock (spread 0 ms) · boundary record 12 ms after its zero'])
      expect(workAxisLines('')).toEqual([])
    })

    it('puts it in the summary, with no timing figure and a plain warning', () => {
      const md = renderSummaryMd(
        [{ workoutId: 'quick-one-two', vocab: 'numbers', verdict: 'PASS', verifyExit: 0, timingVerdict: 'NOT JUDGED', timingRefusal: 'the device is an emulator, and an emulator on this PC is a PC', workAxis: workAxisLines(capture), breathFloor: null, elapsedMs: 1000 }],
        { suiteId: '1', deviceId: 'emulator-5556', deviceIsEmulator: true, launch: 'cold', vocab: 'numbers', sim: 'captured-jam', firstRoundOnly: false, timingGate: 'fail', exitCode: 0 },
      )
      expect(md).toContain('device emulator-5556 (an emulator) ·')
      expect(md).toContain('| quick-one-two | numbers | PASS |  | 0 | not judged | — | — | — |')
      expect(md).toContain('### Timing — not judged')
      expect(md).toContain('no tablet constant is set from any of them')
      expect(md).toContain('- **quick-one-two (numbers)** — round 0: 2 ring tokens place the work clock (spread 0 ms) · boundary record 12 ms after its zero')
    })

    it('says nothing of the kind for a tablet', () => {
      const md = renderSummaryMd(
        [{ workoutId: 'body-work', vocab: 'numbers', verdict: 'PASS', verifyExit: 0, timingExit: 0, timingVerdict: 'PASS', breathFloor: null, elapsedMs: 1000 }],
        { suiteId: '1', deviceId: 'dev', launch: 'cold', vocab: 'numbers', sim: 'captured-jam', firstRoundOnly: false, timingGate: 'fail', exitCode: 0 },
      )
      expect(md).toContain('device dev · cold launch')
      expect(md).toContain('| 0 PASS |')
      expect(md).not.toContain('not judged')
    })
  })
})

describe('--require-sha: the installed build must be the commit asked for', () => {
  it('knows the same commit by either id being a prefix of the other', () => {
    expect(sameCommit('8a080194', '8a080194c0ffee')).toBe(true)
    expect(sameCommit('8a080194c0ffee', '8a080194')).toBe(true)
    expect(sameCommit('8a080194', '6b47e616')).toBe(false)
    expect(sameCommit('unknown', 'unknown')).toBe(false)
    expect(sameCommit('', '8a080194')).toBe(false)
    expect(sameCommit(undefined, '8a080194')).toBe(false)
  })

  it('refuses nothing when no commit is required', () => {
    expect(buildRefusal({ installed: '6b47e616', required: undefined })).toBeNull()
  })

  it('lets the required build through', () => {
    expect(buildRefusal({ installed: '8a080194', required: '8a080194c0ffee' })).toBeNull()
  })

  it('refuses another commit, naming both', () => {
    expect(buildRefusal({ installed: '6b47e616', required: '8a080194' })).toBe('build-mismatch: the installed build is 6b47e616, and --require-sha asked for 8a080194')
  })

  it('refuses a build that cannot say what it is', () => {
    expect(buildRefusal({ installed: 'unknown', required: '8a080194' })).toMatch(/installed build is unknown/)
    expect(buildRefusal({ installed: null, required: '8a080194' })).toMatch(/installed build is unknown/)
  })
})

describe('the rings, in the verify suite', () => {
  const clean = { hard: [], soft: [] }
  const soft = { hard: [], soft: ['1 ring(s) were stepped over by a late frame — first: ring 2 of b'] }
  const hard = { hard: ['1 bar(s) did not light all their rings — first: a reached ring 2 of 3'], soft: [] }

  describe('--rings-gate', () => {
    it('starts at warn, and takes off or fail', () => {
      expect(parseArgs(['--all']).ringsGate).toBe('warn')
      expect(parseArgs(['--all', '--rings-gate=fail']).ringsGate).toBe('fail')
      expect(parseArgs(['--all', '--rings-gate=off']).ringsGate).toBe('off')
      expect(() => parseArgs(['--all', '--rings-gate=loud'])).toThrow(/--rings-gate/)
    })

    it('judges nothing when off', () => {
      expect(ringGateVerdict(hard, 'off')).toBe('PASS')
    })

    it('at warn, a bar the app says was unlit is a WARN — and softer findings change nothing', () => {
      // Staged: a device's log has never been read this way before.
      expect(ringGateVerdict(hard, 'warn')).toBe('WARN')
      expect(ringGateVerdict(soft, 'warn')).toBe('PASS')
      expect(ringGateVerdict(clean, 'warn')).toBe('PASS')
    })

    it('at fail, an unlit bar is a FAIL and a softer finding a WARN', () => {
      expect(ringGateVerdict(hard, 'fail')).toBe('FAIL')
      expect(ringGateVerdict(soft, 'fail')).toBe('WARN')
      expect(ringGateVerdict(clean, 'fail')).toBe('PASS')
    })
  })

  describe('the table cell', () => {
    const stamped = { lit: 194, rings: 194, rows: { lit: 180, masked: 14, other: 0, unrecorded: 0 }, paintedLate: { n: 194, medianMs: 13.2, maxMs: 14.1 } }

    it('says how many the walk reached, how many were on a lit row, and how late', () => {
      expect(ringsCell(stamped)).toBe('194 of 194 · 180 lit, 14 dim · 13.2 / 14.1 ms late')
    })

    it('names rings stepped to while another bar’s row was on stage', () => {
      expect(ringsCell({ ...stamped, rows: { lit: 178, masked: 14, other: 2, unrecorded: 0 } })).toBe('194 of 194 · 178 lit, 14 dim, 2 off-row · 13.2 / 14.1 ms late')
    })

    it('says so when the capture is from a build that recorded neither', () => {
      // September's tablet captures: a bar and a ring per step, and no more.
      const bare = { lit: 506, rings: 506, rows: { lit: 0, masked: 0, other: 0, unrecorded: 506 }, paintedLate: { n: 0, medianMs: null, maxMs: null } }
      expect(ringsCell(bare)).toBe('506 of 506 · when: not recorded')
    })

    it('is a dash for a drive that never reached a round', () => {
      expect(ringsCell(null)).toBe('—')
      expect(ringsCell(undefined)).toBe('—')
    })
  })

  describe('the summary', () => {
    const meta = { suiteId: '1', deviceId: 'dev', launch: 'cold', vocab: 'numbers', sim: 'captured-jam', firstRoundOnly: false, timingGate: 'fail', exitCode: 0 }
    const rings = { lit: 194, rings: 194, rows: { lit: 180, masked: 14, other: 0, unrecorded: 0 }, paintedLate: { n: 194, medianMs: 13.2, maxMs: 14.1 } }

    it('has a rings column, after the breath cells', () => {
      const md = renderSummaryMd([{ workoutId: 'body-work', vocab: 'numbers', verdict: 'PASS', verifyExit: 0, timingExit: 0, timingVerdict: 'PASS', breathFloor: null, rings, elapsedMs: 1000 }], meta)
      expect(md).toContain('| under floor | rings | stats |')
      expect(md).toContain('| — | — | — | 194 of 194 · 180 lit, 14 dim · 13.2 / 14.1 ms late |')
      expect(md).not.toContain('### Rings — findings')
    })

    it('lists every ring finding under the workout it belongs to', () => {
      const md = renderSummaryMd(
        [{ workoutId: 'body-work', vocab: 'numbers', verdict: 'WARN', verifyExit: 0, breathFloor: null, rings, ringVerdict: 'WARN', ringFindings: [...hard.hard, ...soft.soft], elapsedMs: 1000 }],
        meta,
      )
      expect(md).toContain('### Rings — findings')
      expect(md).toContain('- **body-work (numbers)** — 1 bar(s) did not light all their rings — first: a reached ring 2 of 3')
      expect(md).toContain('- **body-work (numbers)** — 1 ring(s) were stepped over by a late frame — first: ring 2 of b')
      expect(md).toContain('A log line that never arrived is not a ring that did not light')
    })
  })
})
