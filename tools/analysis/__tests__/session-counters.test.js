/**
 * Counters that could never count.
 *
 * Three places matched `workouts.` — with an s — where the app logs
 * `workout.`. Two sat in the verify suite's per-drive counters (a blocked QA
 * link, a missing instrument clip) and always read 0; the third made every
 * forensic drive warn that it had no `viz.batch` lines. A counter that
 * cannot move looks exactly like a clean run.
 */

import { vizBatchCount } from '../drive-workout-first-round.mjs'
import { sessionCounters } from '../verify-suite.mjs'

const NL = String.fromCharCode(10)
const line = (body) => `11-27 10:00:00.000 I/ReactNativeJS( 8286): ${body}`
const record = (level, code, fields) => line(`'[${level}] ${code}', 'message', { ${fields} }`)

describe('the verify suite’s session counters', () => {
  it('counts a QA link that was blocked', () => {
    const text = [record('WARN', 'workout.qa.run.blocked', "workout: 'body-work'"), record('INFO', 'workout.qa.run', "workout: 'body-work'")].join(NL)
    expect(sessionCounters(text).qaBlocked).toBe(1)
  })

  it('counts a missing instrument clip, each time', () => {
    const text = [record('WARN', 'workout.instrument.clipMissing', "id: 'stab-60'"), record('WARN', 'workout.instrument.clipMissing', "id: 'stab-62'")].join(NL)
    expect(sessionCounters(text).instrumentClipMissing).toBe(2)
  })

  it('reads a capture from before the rename as well', () => {
    const text = [record('WARN', 'puncheokie.qa.run.blocked', "workout: 'body-work'"), record('WARN', 'puncheokie.instrument.clipMissing', "id: 'stab-60'")].join(NL)
    expect(sessionCounters(text)).toMatchObject({ qaBlocked: 1, instrumentClipMissing: 1 })
  })

  it('reads zero when neither happened', () => {
    expect(sessionCounters(record('INFO', 'workout.qa.run', "workout: 'body-work'"))).toMatchObject({ qaBlocked: 0, instrumentClipMissing: 0 })
  })
})

describe('a forensic drive’s viz.batch count', () => {
  it('counts the batches the app wrote', () => {
    const text = [record('INFO', 'workout.viz.batch', 'count: 1'), record('INFO', 'workout.viz.batch', 'count: 2'), record('INFO', 'workout.cue.tokenDue', 'ordinal: 0')].join(NL)
    expect(vizBatchCount(text)).toBe(2)
  })

  it('reads zero from a capture with none', () => {
    expect(vizBatchCount(record('INFO', 'workout.cue.tokenDue', 'ordinal: 0'))).toBe(0)
  })
})
