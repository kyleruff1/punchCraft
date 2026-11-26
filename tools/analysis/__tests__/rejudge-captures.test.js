/**
 * Re-judging stored captures: which directories count as a capture, which
 * workout each is of, and that a stored verdict is set beside today's.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { captureDirs, reasonsOf, rejudge, tallyOf, workoutOf } from '../rejudge-captures.mjs'

const line = (time, body) => `09-11 ${time} I/ReactNativeJS(27872): ${body}`
const callAt = (second) => {
  const time = `10:09:${String(42 + second).padStart(2, '0')}.000`
  return [
    line(time, "'[INFO] puncheokie.clickScript.dispatch', 'click script dispatched', { kind: 'call',"),
    line(time, "  slot: 'call/1-2b-1-2b',"),
    line(time, '  dispatchAtMs: 2398 }'),
  ]
}
/** A pre-rename capture with `calls` per-bar calls in round one. */
const capture = (calls) =>
  [
    line('10:09:41.000', "'[INFO] puncheokie.metronome', 'loop started', { bpm: 240 }"),
    ...Array.from({ length: calls }, (_, i) => callAt(i)).flat(),
    '',
  ].join('\n')

const manifest = (workoutId, expectedCallBars) => ({
  workoutId,
  identity: { workoutId, revision: 1, timelineHash: 'v2:00000000' },
  workDurationMs: 240_000,
  bpm: 240,
  coachEvents: [],
  strikes: [],
  expectedCallBars,
})

let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rejudge-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function put(relPath, content) {
  const full = join(root, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content))
}

describe('finding captures', () => {
  it('takes any directory holding a capture log, at any depth', () => {
    put('data/suites/run1/body-work/logcat.txt', capture(1))
    put('data/sessions/body-work-1788226910147/logcat.txt', capture(1))
    put('data/monitor/earcheck/log.txt', capture(1))
    put('data/monitor/earcheck/notes.md', 'not a capture')
    const found = captureDirs(join(root, 'data')).map((d) => relative(join(root, 'data'), d).split(sep).join('/'))
    expect(found).toEqual(
      expect.arrayContaining(['suites/run1/body-work', 'sessions/body-work-1788226910147', 'monitor/earcheck']),
    )
  })

  it('names the workout from the directory, with or without a timestamp', () => {
    expect(workoutOf('suites/run1/body-work')).toBe('body-work')
    expect(workoutOf('sessions/body-work-1788226910147')).toBe('body-work')
    expect(workoutOf('sessions/establish-the-jab-20-1788225686906')).toBe('establish-the-jab-20')
  })
})

describe('rejudge', () => {
  it("sets today's verdict beside the stored one, with the reasons", () => {
    put('manifests/body-work.json', manifest('body-work', 3))
    put('data/suites/run1/body-work/logcat.txt', capture(3))
    put('data/suites/run1/body-work/verify-report.json', { health: { verdict: 'PASS' } })
    put('data/suites/run2/body-work/logcat.txt', capture(0))

    const rows = rejudge(join(root, 'data'), join(root, 'manifests'))
    const byCapture = Object.fromEntries(rows.map((r) => [r.capture, r]))

    // Every call arrived; only the missing timeline hash keeps it from PASS.
    expect(byCapture['suites/run1/body-work']).toMatchObject({ was: 'PASS', now: 'WARN', calls: '3/3' })
    expect(byCapture['suites/run1/body-work'].reasons).toContain('identityUnknown')
    // No calls at all, where three were expected: a hard failure.
    expect(byCapture['suites/run2/body-work']).toMatchObject({ was: null, now: 'FAIL' })
    expect(byCapture['suites/run2/body-work'].reasons).toContain('noCalls')
  })

  it('says so when a capture has no manifest, rather than skipping it', () => {
    put('manifests/body-work.json', manifest('body-work', 3))
    put('data/monitor/earcheck/log.txt', capture(3))
    expect(rejudge(join(root, 'data'), join(root, 'manifests'))).toEqual([
      expect.objectContaining({ capture: 'monitor/earcheck', now: 'NO-MANIFEST' }),
    ])
  })
})

describe('reporting', () => {
  it('tallies how verdicts moved, most common first', () => {
    const rows = [
      { was: 'PASS', now: 'WARN' },
      { was: 'PASS', now: 'WARN' },
      { was: null, now: 'FAIL' },
    ]
    expect(tallyOf(rows)).toEqual([
      ['PASS -> WARN', 2],
      ['- -> FAIL', 1],
    ])
  })

  it('names what is behind a verdict', () => {
    expect(reasonsOf({ missing: 2, late: 0, noCalls: true, stale: false })).toEqual(['missing=2', 'noCalls'])
  })
})
