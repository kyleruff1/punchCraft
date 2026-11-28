/**
 * The PC suite's judgement, without a browser: how far a drive got, what
 * verdict it earns, and what the summary says. The drive itself is proved by
 * running it (`npm run pc:suite`), which a unit test cannot do.
 */
import { driveState } from '../drive.mjs'
import { spread } from '../stats.mjs'
import {
  admissions,
  defaultJobs,
  driveVerdict,
  endedAsMeant,
  lateness,
  parseArgs,
  pooled,
  observerLine,
  renderSummary,
} from '../suite.mjs'

const record = (code, fields = {}) => ({
  wallMs: 0,
  monoMs: 0,
  level: 'info',
  args: [`[INFO] ${code}`, 'message', fields],
})
const boundary = (transition, roundIndex = 0) =>
  record('workout.round.boundary', { transition, roundIndex })
const staged = (fields = {}) =>
  record('workout.qa.run', { nonce: 'n-1', gitSha: 'abc1234', platform: 'web', ...fields })
const aRound = [
  staged(),
  record('workout.runner.start'),
  boundary('countdown-entered'),
  boundary('work-entered'),
  boundary('rest-entered'),
  boundary('work-entered', 1),
]

describe('driveState', () => {
  it('follows a drive from the link to the end of round 1', () => {
    expect(driveState([])).toEqual({
      staged: null,
      refused: null,
      started: false,
      workEntered: false,
      ended: null,
    })
    expect(driveState(aRound.slice(0, 2))).toMatchObject({
      started: true,
      workEntered: false,
      ended: null,
    })
    expect(driveState(aRound.slice(0, 4))).toMatchObject({ workEntered: true, ended: null })
    // The end of round 1 is not the end of the run: the rest after it is in it.
    expect(driveState(aRound.slice(0, 5)).ended).toBeNull()
    expect(driveState(aRound)).toMatchObject({ ended: 'work-entered', staged: { nonce: 'n-1' } })
  })

  it('does not stop a whole workout at its first rest', () => {
    expect(driveState(aRound, { firstRoundOnly: false }).ended).toBeNull()
    expect(driveState([...aRound, boundary('completed')], { firstRoundOnly: false }).ended).toBe(
      'completed',
    )
  })

  it('ends on a stop as well as on a bell, and keeps the first ending it saw', () => {
    expect(driveState([...aRound.slice(0, 4), boundary('cancelled')]).ended).toBe('cancelled')
    expect(driveState([...aRound, boundary('completed', 1)]).ended).toBe('work-entered')
    // A one-round workout has no second bell; it completes.
    expect(driveState([...aRound.slice(0, 4), boundary('completed')]).ended).toBe('completed')
  })

  it('says why a link was refused', () => {
    expect(driveState([record('workout.qa.run.blocked')]).refused).toBe('qa-flag-off')
    expect(driveState([record('workout.qa.run.invalid')]).refused).toBe('invalid-link')
  })
})

describe('parseArgs', () => {
  it('defaults to every workout, round 1, the tablet suite’s simulated punches, and a fresh build', () => {
    expect(parseArgs([])).toEqual({
      only: [],
      vocab: 'numbers',
      full: false,
      build: true,
      out: null,
      sim: 'captured-jam',
      sound: true,
      record: false,
      soundGate: 'fail',
      fault: null,
      jobs: null,
    })
  })
  it('takes how many to run at once, as a whole number of one or more', () => {
    expect(parseArgs(['--jobs', '3']).jobs).toBe(3)
    expect(() => parseArgs(['--jobs', '0'])).toThrow(/--jobs is a whole number, 1 or more/)
    expect(() => parseArgs(['--jobs', 'many'])).toThrow(/--jobs is a whole number/)
  })
  it('takes a gate level and a fault, and only ones it knows', () => {
    expect(parseArgs(['--sound-gate', 'warn', '--fault=cut'])).toMatchObject({
      soundGate: 'warn',
      fault: 'cut',
    })
    expect(() => parseArgs(['--sound-gate', 'maybe'])).toThrow(/--sound-gate is fail, warn or off/)
    expect(() => parseArgs(['--fault', 'explode'])).toThrow(/--fault is one of mute, cut, late/)
    expect(() => parseArgs(['--fault', 'mute', '--no-sound'])).toThrow(
      /--fault needs the sound tap/,
    )
  })
  it('listens to the sound unless told not to, and keeps it only when asked', () => {
    expect(parseArgs(['--no-sound'])).toMatchObject({ sound: false, record: false })
    expect(parseArgs(['--record'])).toMatchObject({ sound: true, record: true })
    expect(() => parseArgs(['--record', '--no-sound'])).toThrow(/--record needs the sound tap/)
  })
  it('reads values after the flag or joined to it', () => {
    expect(
      parseArgs([
        '--only',
        'a,b',
        '--only=c',
        '--vocab=both',
        '--full',
        '--no-build',
        '--out',
        'x',
        '--sim=none',
      ]),
    ).toEqual({
      only: ['a', 'b', 'c'],
      vocab: 'both',
      full: true,
      build: false,
      out: 'x',
      sim: 'none',
      sound: true,
      record: false,
      soundGate: 'fail',
      fault: null,
      jobs: null,
    })
  })
  it('refuses what it does not know rather than running something else', () => {
    expect(() => parseArgs(['--first-round-only'])).toThrow(/unknown argument: --first-round-only/)
    expect(() => parseArgs(['--vocab', 'french'])).toThrow(/numbers, techniques or both/)
    expect(() => parseArgs(['--only'])).toThrow(/--only needs a value/)
  })
})

describe('running several at once', () => {
  it('runs half the processors’ worth, at least one and at most six', () => {
    expect([1, 2, 4, 8, 16, 64].map((n) => defaultJobs(n))).toEqual([1, 1, 2, 4, 6, 6])
  })

  it('never runs more than the limit at once, and returns results in the order asked', async () => {
    let running = 0
    let most = 0
    const release = []
    const task = (item) =>
      new Promise((resolve) => {
        running += 1
        most = Math.max(most, running)
        release.push(() => {
          running -= 1
          resolve(item * 10)
        })
      })
    const done = pooled([1, 2, 3, 4, 5], 2, task)
    // Finish them out of order: the last started first.
    for (let turn = 0; turn < 5; turn += 1) {
      await Promise.resolve()
      release.pop()()
      await Promise.resolve()
      await Promise.resolve()
    }
    await expect(done).resolves.toEqual([10, 20, 30, 40, 50])
    expect(most).toBe(2)
  })

  it('copes with fewer items than the limit, and with none', async () => {
    await expect(pooled(['a'], 6, async (item) => item + '!')).resolves.toEqual(['a!'])
    await expect(pooled([], 6, async () => 1)).resolves.toEqual([])
  })
})

describe('lateness', () => {
  it('gives the median, the 95th percentile and the worst', () => {
    expect(spread([5, 1, 3])).toEqual({ n: 3, minMs: 1, medianMs: 3, p95Ms: 5, maxMs: 5 })
    expect(spread([])).toEqual({ n: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null })
    expect(spread([2, undefined, NaN, 4]).n).toBe(2)
  })
  it('reads dispatch lateness and the ring token’s lateness against its own schedule', () => {
    const records = [
      record('workout.clickScript.dispatch', { lateMs: 40 }),
      record('workout.clickScript.dispatch', { lateMs: 36 }),
      record('workout.cue.tokenDue', { workElapsedMs: 4037.7, scheduledMs: 4000 }),
    ]
    expect(lateness(records).dispatch).toMatchObject({ n: 2, medianMs: 40 })
    expect(lateness(records).ringToken).toMatchObject({ n: 1, medianMs: 37.7 })
  })
})

describe('driveVerdict', () => {
  const drive = (over = {}) => ({
    records: aRound,
    problems: [],
    ended: 'work-entered',
    reason: null,
    staged: { nonce: 'n-1', gitSha: 'abc1234' },
    visibility: 'visible',
    url: 'http://127.0.0.1:1/qa/run?x',
    elapsedMs: 1,
    ...over,
  })
  const judged = (over, verifyExit = 0) =>
    driveVerdict({ drive: drive(over), verifyExit, hostSha: 'abc1234', nonce: 'n-1' })

  it('is the correlator’s word when nothing else went wrong', () => {
    expect(judged({}, 0)).toEqual({ verdict: 'PASS', reasons: [] })
    expect(judged({}, 2).verdict).toBe('WARN')
    expect(judged({}, 1).verdict).toBe('FAIL')
    expect(judged({}, 4)).toEqual({
      verdict: 'STALE',
      reasons: [expect.stringMatching(/different timeline/)],
    })
  })

  it('is an ERROR when the drive itself broke — there is no round to judge', () => {
    expect(judged({ reason: 'qa-flag-off', ended: null }, null)).toEqual({
      verdict: 'ERROR',
      reasons: ['qa-flag-off'],
    })
    expect(judged({ records: aRound.slice(0, 2), ended: null }, null).reasons).toEqual([
      'the round never began',
    ])
    expect(judged({ staged: { nonce: 'someone-else', gitSha: 'abc1234' } }).reasons[0]).toMatch(
      /different link/,
    )
  })

  it('is an ERROR when the round began and never ended, whatever the correlator made of it', () => {
    const result = judged({ reason: 'over-budget', ended: null }, 0)
    expect(result.verdict).toBe('ERROR')
    expect(result.reasons).toEqual(['the round did not end within its budget'])
  })

  it('fails on anything the page complained about — the smoke test’s rule', () => {
    const result = judged({ problems: ['console.error: boom', 'another'] }, 0)
    expect(result.verdict).toBe('FAIL')
    expect(result.reasons).toEqual(['2 error(s) on the page: console.error: boom'])
  })

  it('warns when the build is not the checkout, or the page was not being shown', () => {
    expect(judged({ staged: { nonce: 'n-1', gitSha: 'old0000' } })).toEqual({
      verdict: 'WARN',
      reasons: ['the build is old0000, the checkout is abc1234'],
    })
    expect(judged({ visibility: 'hidden' }).verdict).toBe('WARN')
  })

  describe('with the sound gate', () => {
    const heardBad = {
      verdict: 'FAIL',
      hard: ['1 clip(s) were played and made no sound — first: call/1-2, round 1'],
      soft: [],
    }
    const heardTight = {
      verdict: 'WARN',
      hard: [],
      soft: ['3 of 78 calls (3.8%) stopped less than 150 ms before their ring'],
    }
    const withSound = (sound, soundGate, verifyExit = 0) =>
      driveVerdict({
        drive: drive(),
        verifyExit,
        hostSha: 'abc1234',
        nonce: 'n-1',
        sound,
        soundGate,
      })

    it('fails a drive the correlator passed, when a clip made no sound', () => {
      expect(withSound(heardBad, 'fail')).toEqual({ verdict: 'FAIL', reasons: heardBad.hard })
    })
    it('only warns at the warn level, and says nothing when switched off', () => {
      expect(withSound(heardBad, 'warn')).toEqual({ verdict: 'WARN', reasons: heardBad.hard })
      expect(withSound(heardBad, 'off')).toEqual({ verdict: 'PASS', reasons: [] })
    })
    it('warns on a soft finding at either level', () => {
      expect(withSound(heardTight, 'fail').verdict).toBe('WARN')
      expect(withSound(heardTight, 'warn').verdict).toBe('WARN')
    })
    it('cannot rescue a drive the correlator failed', () => {
      expect(withSound({ verdict: 'PASS', hard: [], soft: [] }, 'fail', 1).verdict).toBe('FAIL')
    })
    it('leaves the verdict alone when nothing listened', () => {
      expect(withSound(null, 'fail')).toEqual({ verdict: 'PASS', reasons: [] })
    })
  })

  describe('with the ring check', () => {
    const withRings = (rings, verifyExit = 0) =>
      driveVerdict({ drive: drive(), verifyExit, hostSha: 'abc1234', nonce: 'n-1', rings })

    it('fails a drive where a bar did not light all its rings', () => {
      const unlit = {
        hard: ['1 bar(s) did not light all their rings — first: q121-b1#0 reached ring 1 of 2'],
        soft: [],
      }
      expect(withRings(unlit)).toEqual({ verdict: 'FAIL', reasons: unlit.hard })
    })
    it('warns on a late ring, and cannot rescue a drive the correlator failed', () => {
      const late = { hard: [], soft: ['2 ring(s) were painted more than 100 ms after their time'] }
      expect(withRings(late).verdict).toBe('WARN')
      expect(withRings({ hard: [], soft: [] }, 1).verdict).toBe('FAIL')
    })
  })

  describe('what the app itself admitted', () => {
    const failed = record('workout.voice.playFailed', {
      asset: 'li-2ba7c178',
      error: 'no such file',
    })
    const missing = record('workout.voice.clipMissing', { asset: 'call-9-9' })
    const skipped = record('workout.clickScript.skipped', { slot: 'call/1-2' })

    it('counts the clips it logged it could not play, and the calls it chose to skip', () => {
      expect(admissions([...aRound, failed, missing, skipped, skipped])).toEqual({
        couldNotPlay: ['voice.playFailed: li-2ba7c178', 'voice.clipMissing: call-9-9'],
        skipped: 2,
        deferred: 0,
      })
    })

    it('fails the drive on a clip the app could not play — in any round, whatever the correlator said', () => {
      const result = judged({ records: [...aRound, failed] }, 0)
      expect(result).toEqual({
        verdict: 'FAIL',
        reasons: [
          'the app logged 1 clip(s) it could not play — first: voice.playFailed: li-2ba7c178',
        ],
      })
    })

    it('does not fail it on a call the app chose to skip', () => {
      expect(judged({ records: [...aRound, skipped] }, 0).verdict).toBe('PASS')
    })
  })

  it('never lets a warning soften a failure', () => {
    expect(judged({ visibility: 'hidden' }, 1).verdict).toBe('FAIL')
  })
})

describe('renderSummary', () => {
  const row = (over = {}) => ({
    workoutId: 'quick-one-two',
    vocab: 'numbers',
    verdict: 'PASS',
    reasons: [],
    stats: 'matched=3 extras=0 reanchor=0',
    pageProblems: [],
    lateness: { dispatch: { medianMs: 36, p95Ms: 44 }, ringToken: { medianMs: 39.7, p95Ms: 45.3 } },
    elapsedMs: 282_000,
    ...over,
  })
  const meta = {
    suiteId: '2026-11-27-03-40-12',
    hostSha: 'abc1234',
    browser: '/opt/chrome',
    args: parseArgs([]),
  }

  it('gives a row per drive and a tally', () => {
    const md = renderSummary(
      [
        row(),
        row({ workoutId: 'body-work', verdict: 'FAIL', reasons: ['1 error(s) on the page: x'] }),
      ],
      meta,
    )
    expect(md).toContain('**1 PASS · 1 FAIL**')
    // No sound was listened to in this row: its three columns are dashes.
    expect(md).toContain(
      '| quick-one-two | numbers | PASS | matched=3 extras=0 reanchor=0 | 0 | — | — | — | — | — | 36 / 44 | 39.7 / 45.3 | 4:42 |',
    )
    expect(md).toContain('- **body-work** (numbers): 1 error(s) on the page: x')
    expect(md).toContain('round 1 and its rest · 1 at a time · simulated punches: captured-jam')
    const six = renderSummary([row()], { ...meta, args: { ...meta.args, jobs: 6 } })
    expect(six).toContain('round 1 and its rest · 6 at a time ·')
  })

  it('shows what was heard: clips, losses, and the tightest and the usual gap before a ring', () => {
    const sound = {
      clips: { played: 81, heard: 80, silent: [{}], cutShort: [] },
      calls: { breath: { minMs: 351, medianMs: 376.8 } },
    }
    const md = renderSummary([row({ sound })], meta)
    expect(md).toContain('| 0 | 80 of 81 | 1 / 0 | 351 / 376.8 | — | — | 36 / 44 |')
    expect(md).toMatch(/sound columns are measured/)
  })

  it('says how the app’s own observer compared with the audio elements, over every drive', () => {
    const sound = (observer) => ({
      clips: { played: 81, heard: 81, silent: [], cutShort: [] },
      calls: { breath: { minMs: 351, medianMs: 376.8 } },
      observer,
    })
    const one = {
      records: 87,
      compared: 87,
      startMs: { minMs: -11.5, maxMs: 8.6 },
      endMs: { minMs: -1.1, maxMs: 0.5 },
      unseen: [],
      unheard: [],
    }
    const two = {
      records: 90,
      compared: 88,
      startMs: { minMs: -3, maxMs: 9.2 },
      endMs: { minMs: -0.4, maxMs: 2 },
      unseen: [{}],
      unheard: [],
    }
    const md = renderSummary(
      [row({ sound: sound(one) }), row({ sound: sound(two), vocab: 'techniques' })],
      meta,
    )
    expect(md).toContain('## The app’s own observer')
    expect(md).toContain('timed 177 plays')
    expect(md).toContain('175 of them')
    expect(md).toContain('at most 11.5 ms on when a clip began and 2 ms on when it ended')
    expect(md).toContain('1 sounded that the observer never saw start')
  })

  it('leaves the observer out when no drive had anything to compare', () => {
    expect(renderSummary([row()], meta)).not.toContain('own observer')
    expect(observerLine([row({ sound: { observer: { compared: 0 } } })])).toBeNull()
  })

  it('shows how many rings lit, and how late they were painted', () => {
    const rings = { lit: 194, rings: 194, paintedLate: { medianMs: 54.4, maxMs: 67.8 } }
    expect(renderSummary([row({ rings })], meta)).toContain(
      '| — | 194 of 194 | 54.4 / 67.8 | 36 / 44 |',
    )
  })

  it('says in its heading how the sound was judged, and shouts when a fault was injected', () => {
    expect(renderSummary([row()], meta)).toContain('· sound gate: fail ·')
    expect(renderSummary([row()], { ...meta, args: parseArgs(['--no-sound']) })).toContain(
      '· sound not listened to ·',
    )
    const faulted = renderSummary([row()], { ...meta, args: parseArgs(['--fault', 'mute']) })
    expect(faulted).toContain('**Fault injected on purpose: `mute`.')
    expect(renderSummary([row()], meta)).not.toContain('Fault injected')
  })

  it('says whose numbers the lateness columns are', () => {
    const md = renderSummary([row()], meta)
    expect(md).toMatch(/lateness columns are this PC’s/)
    expect(md).toMatch(/no tablet constant is ever set from them/)
  })

  it('shows a dash where a drive measured nothing', () => {
    const md = renderSummary(
      [
        row({
          verdict: 'ERROR',
          stats: null,
          lateness: {
            dispatch: { medianMs: null, p95Ms: null },
            ringToken: { medianMs: null, p95Ms: null },
          },
        }),
      ],
      meta,
    )
    expect(md).toContain('| ERROR | — | 0 | — | — | — | — | — | — / — | — / — |')
  })
})

describe('how far a drive was meant to run', () => {
  it('ran as meant when it ended on the bell that opens round 2, or on the last one', () => {
    expect(endedAsMeant({ ended: 'work-entered', reason: null })).toBe(true)
    expect(endedAsMeant({ ended: 'completed', reason: null })).toBe(true)
  })

  it('did not when it was cancelled, ran out of time, or never ended', () => {
    expect(endedAsMeant({ ended: 'cancelled', reason: null })).toBe(false)
    expect(endedAsMeant({ ended: null, reason: 'over-budget' })).toBe(false)
    expect(endedAsMeant({ ended: null, reason: null })).toBe(false)
  })

  it('shows how many rounds the correlator judged beside its counts', () => {
    const row = {
      workoutId: 'body-work',
      vocab: 'numbers',
      verdict: 'PASS',
      reasons: [],
      stats: 'matched=12 extras=0 reanchor=0',
      roundsJudged: '4 of 4 rounds',
      pageProblems: [],
      lateness: {
        dispatch: { medianMs: 36, p95Ms: 44 },
        ringToken: { medianMs: 39.7, p95Ms: 45.3 },
      },
      elapsedMs: 900_000,
    }
    const meta = {
      suiteId: 's',
      hostSha: 'abc1234',
      browser: '/opt/chrome',
      args: parseArgs(['--full']),
    }
    const md = renderSummary([row], meta)
    expect(md).toContain('| PASS | matched=12 extras=0 reanchor=0 · 4 of 4 rounds | 0 |')
    expect(md).toContain('**How far a drive was meant to run is part of the verdict.**')
    expect(md).not.toContain('have no independent check')
  })
})
