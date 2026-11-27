/**
 * The PC suite's judgement, without a browser: how far a drive got, what
 * verdict it earns, and what the summary says. The drive itself is proved by
 * running it (`npm run pc:suite`), which a unit test cannot do.
 */
import { driveState } from '../drive.mjs'
import { spread } from '../stats.mjs'
import { driveVerdict, lateness, parseArgs, renderSummary } from '../suite.mjs'

const record = (code, fields = {}) => ({
  wallMs: 0,
  monoMs: 0,
  level: 'info',
  args: [`[INFO] ${code}`, 'message', fields],
})
const boundary = (transition) => record('workout.round.boundary', { transition, roundIndex: 0 })
const staged = (fields = {}) =>
  record('workout.qa.run', { nonce: 'n-1', gitSha: 'abc1234', platform: 'web', ...fields })
const aRound = [
  staged(),
  record('workout.runner.start'),
  boundary('countdown-entered'),
  boundary('work-entered'),
  boundary('rest-entered'),
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
    expect(driveState(aRound)).toMatchObject({ ended: 'rest-entered', staged: { nonce: 'n-1' } })
  })

  it('does not stop a whole workout at its first rest', () => {
    expect(driveState(aRound, { firstRoundOnly: false }).ended).toBeNull()
    expect(driveState([...aRound, boundary('completed')], { firstRoundOnly: false }).ended).toBe(
      'completed',
    )
  })

  it('ends on a stop as well as on a bell, and keeps the first ending it saw', () => {
    expect(driveState([...aRound.slice(0, 4), boundary('cancelled')]).ended).toBe('cancelled')
    expect(driveState([...aRound, boundary('completed')]).ended).toBe('rest-entered')
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
    })
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
    })
  })
  it('refuses what it does not know rather than running something else', () => {
    expect(() => parseArgs(['--first-round-only'])).toThrow(/unknown argument: --first-round-only/)
    expect(() => parseArgs(['--vocab', 'french'])).toThrow(/numbers, techniques or both/)
    expect(() => parseArgs(['--only'])).toThrow(/--only needs a value/)
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
    ended: 'rest-entered',
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
      '| quick-one-two | numbers | PASS | matched=3 extras=0 reanchor=0 | 0 | — | — | — | 36 / 44 | 39.7 / 45.3 | 4:42 |',
    )
    expect(md).toContain('- **body-work** (numbers): 1 error(s) on the page: x')
    expect(md).toContain('round 1 · simulated punches: captured-jam')
  })

  it('shows what was heard: clips, losses, and the tightest and the usual gap before a ring', () => {
    const sound = {
      clips: { played: 81, heard: 80, silent: [{}], cutShort: [] },
      calls: { breath: { minMs: 351, medianMs: 376.8 } },
    }
    const md = renderSummary([row({ sound })], meta)
    expect(md).toContain('| 0 | 80 of 81 | 1 / 0 | 351 / 376.8 | 36 / 44 |')
    expect(md).toMatch(/sound columns are measured/)
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
    expect(md).toContain('| ERROR | — | 0 | — | — | — | — / — | — / — |')
  })
})
