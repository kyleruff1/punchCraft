/**
 * A PC run saved in the tablet's layout. The test of that is not what the
 * text looks like but whether the tablet's own parsers read back what the app
 * logged — so every case here goes through `tools/analysis/logcat.mjs`.
 */
import {
  boolField,
  capturePlatform,
  extractField,
  numField,
  recordsWithTag,
  stitchLogRecords,
  WEB_CAPTURE_TAG,
} from '../../../analysis/logcat.mjs'
import { parseVizRecords } from '../../../analysis/token-forensics.mjs'
import {
  codeOf,
  fieldsOf,
  isAppRecord,
  logcatText,
  otherConsoleText,
  recordsOf,
  render,
} from '../capture.mjs'

const START = Date.UTC(2026, 10, 26, 23, 59, 58, 500)
const record = (code, fields, { atMs = 0, level = 'info', message = 'message' } = {}) => ({
  wallMs: START + atMs,
  monoMs: 1000 + atMs,
  level,
  args: [
    `[${level === 'warn' ? 'WARN' : level === 'error' ? 'ERROR' : 'INFO'}] ${code}`,
    message,
    fields,
  ],
})

describe('render — the console’s layout', () => {
  // Bodies copied from a tablet capture (suites/post-floor, 2026-09-08).
  it('prints a short record on one line, as the tablet does', () => {
    expect(render({ cueId: 'bw1-b1#0', lateMs: 16.2 })).toBe("{ cueId: 'bw1-b1#0', lateMs: 16.2 }")
    expect(render({ plannedMs: 25314, playId: 'intro-1' })).toBe(
      "{ plannedMs: 25314, playId: 'intro-1' }",
    )
  })

  it('breaks a long record one field to a line, as the tablet does', () => {
    const fields = {
      transition: 'work-entered',
      roundIndex: 0,
      workElapsedMs: 0,
      monotonicTimeMs: 393016789.780886,
    }
    expect(render(fields).split('\n')).toEqual([
      "{ transition: 'work-entered',",
      '  roundIndex: 0,',
      '  workElapsedMs: 0,',
      '  monotonicTimeMs: 393016789.780886 }',
    ])
  })

  it('prints what is not a string bare', () => {
    expect(render({ a: null, b: undefined, c: true, d: -1.5 })).toBe(
      '{ a: null, b: undefined, c: true, d: -1.5 }',
    )
    expect(render([])).toBe('[]')
    expect(render({})).toBe('{}')
    expect(render([1, 'x'])).toBe("[ 1, 'x' ]")
  })

  it('escapes what would end a quoted string early', () => {
    expect(render("it's")).toBe(String.raw`'it\'s'`)
    expect(render('a\nb')).toBe(String.raw`'a\nb'`)
    // A backslash is doubled. Built from its character code so that no layer
    // between this file and the reader can halve it.
    const backslash = String.fromCharCode(92)
    expect(render(`back${backslash}slash`)).toBe(`'back${backslash}${backslash}slash'`)
  })

  it('quotes a key that is not a plain name', () => {
    expect(render({ 'b-c': 1, ok: 2 })).toBe("{ 'b-c': 1, ok: 2 }")
  })
})

describe('logcatText', () => {
  const dispatch = {
    kind: 'call',
    slot: 'call/1-2-.-.',
    traceId: 'call/1-2-.-.#2602',
    dispatchAtMs: 2602,
    lateMs: 41,
    durationMs: 927,
    endByMs: 4500,
    firstNodeMs: 4000,
    breathMs: 400,
    lagMs: 71,
    armed: false,
    monotonicTimeMs: 50829.39999997616,
  }
  const prefixed = new RegExp('^11-26 00:00:00[.]000 I/' + WEB_CAPTURE_TAG + '[(] +1[)]: ')

  it('is read back whole by the tablet’s parser — every field of a long record', () => {
    const text = logcatText([record('workout.clickScript.dispatch', dispatch)])
    const [read] = recordsWithTag(text, 'workout.clickScript.dispatch')
    expect(extractField(read.body, 'kind')).toBe('call')
    expect(extractField(read.body, 'slot')).toBe('call/1-2-.-.')
    expect(extractField(read.body, 'traceId')).toBe('call/1-2-.-.#2602')
    const numbers = [
      'dispatchAtMs',
      'lateMs',
      'durationMs',
      'endByMs',
      'firstNodeMs',
      'breathMs',
      'lagMs',
      'monotonicTimeMs',
    ]
    for (const key of numbers) expect(numField(read.body, key)).toBe(dispatch[key])
    expect(boolField(read.body, 'armed')).toBe(false)
  })

  it('puts the prefix on every line of a record that wraps', () => {
    const lines = logcatText([record('workout.clickScript.dispatch', dispatch)])
      .trimEnd()
      .split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line).toMatch(prefixed)
    expect(stitchLogRecords(lines.join('\n'))).toHaveLength(1)
  })

  it('says it is the PC’s, by its tag', () => {
    const text = logcatText([record('workout.round.boundary', { transition: 'work-entered' })])
    expect(capturePlatform(text)).toBe('web')
  })

  it('starts its clock at zero, so a run across midnight still reads forwards', () => {
    // The first record is 1.5 s before midnight UTC; the second 4 s after it.
    const text = logcatText([
      record('workout.round.boundary', { transition: 'work-entered' }),
      record('workout.round.boundary', { transition: 'rest-entered' }, { atMs: 5_500 }),
    ])
    const [first, second] = recordsWithTag(text, 'workout.round.boundary')
    expect(first.ts).toBe(0)
    expect(second.ts - first.ts).toBe(5_500)
  })

  it('marks warnings and errors with the level letter', () => {
    const text = logcatText([
      record('a.b', {}, { level: 'warn' }),
      record('c.d', {}, { level: 'error' }),
    ])
    expect(text).toContain(`W/${WEB_CAPTURE_TAG}`)
    expect(text).toContain(`E/${WEB_CAPTURE_TAG}`)
  })

  it('keeps a batch of ring records on one line, where the forensics tool looks for it', () => {
    const batch = [
      {
        kind: 'token',
        cueId: 'q121-b1#1',
        tokenIndex: 1,
        prev: 'upcoming',
        next: 'active',
        source: 'token-due',
        workElapsedMs: 8540.2,
        monotonicMs: 36726.1,
      },
    ]
    const text = logcatText([
      record('workout.viz.batch', { count: 1, records: JSON.stringify(batch) }),
    ])
    expect(parseVizRecords(text)).toEqual([{ ...batch[0], wallTime: '00:00:00.000' }])
  })

  it('leaves out what the app did not log, and keeps it beside the capture', () => {
    const stray = {
      wallMs: START,
      monoMs: 1,
      level: 'warn',
      args: ['Some library says hello', { detail: 1 }],
    }
    const records = [record('workout.round.boundary', { transition: 'work-entered' }), stray]
    expect(stitchLogRecords(logcatText(records))).toHaveLength(1)
    expect(logcatText(records)).not.toContain('library')
    expect(otherConsoleText(records)).toBe('warn: Some library says hello { detail: 1 }')
    expect(logcatText([stray])).toBe('')
  })
})

describe('reading a record', () => {
  const boundary = record('workout.round.boundary', { transition: 'rest-entered', roundIndex: 0 })
  it('names its code and fields', () => {
    expect(isAppRecord(boundary)).toBe(true)
    expect(codeOf(boundary)).toBe('workout.round.boundary')
    expect(fieldsOf(boundary)).toEqual({ transition: 'rest-entered', roundIndex: 0 })
  })
  it('is not fooled by other console output', () => {
    const stray = { wallMs: START, monoMs: 1, level: 'log', args: ['[not a level] x'] }
    expect(isAppRecord(stray)).toBe(false)
    expect(codeOf(stray)).toBeNull()
    expect(fieldsOf(stray)).toEqual({})
    expect(recordsOf([boundary, stray], 'workout.round.boundary')).toEqual([boundary])
  })
})
