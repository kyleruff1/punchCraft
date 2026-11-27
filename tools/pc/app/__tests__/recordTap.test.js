/**
 * The tap that hands the driver every console call whole. It runs inside the
 * page under test, so what matters is that it copies faithfully, never
 * breaks the page's own logging, and still works once it has been turned
 * into text — which is how it gets there.
 */
import { installRecordTap, RECORD_BINDING, RECORD_TAP_SOURCE } from '../recordTap.mjs'

function fakePage({ now = 1234.5, timeOrigin = 1_700_000_000_000 } = {}) {
  const seen = { native: [], sent: [] }
  const scope = {
    performance: { now: () => now, timeOrigin },
    console: Object.fromEntries(
      ['debug', 'log', 'info', 'warn', 'error'].map((level) => [
        level,
        (...args) => seen.native.push([level, ...args]),
      ]),
    ),
    [RECORD_BINDING]: (payload) => seen.sent.push(JSON.parse(payload)),
  }
  return { scope, seen }
}

describe('installRecordTap', () => {
  it('sends a record whole — every field, not a preview of five', () => {
    const { scope, seen } = fakePage()
    installRecordTap(scope, RECORD_BINDING)
    const fields = {
      kind: 'call',
      slot: 'call/1-2-.-.',
      traceId: 't',
      dispatchAtMs: 2602,
      lateMs: 41,
      durationMs: 927,
      endByMs: 4500,
      firstNodeMs: 4000,
    }
    scope.console.info('[INFO] workout.clickScript.dispatch', 'click script dispatched', fields)
    expect(seen.sent).toEqual([
      {
        wallMs: 1_700_000_001_234.5,
        monoMs: 1234.5,
        level: 'info',
        args: ['[INFO] workout.clickScript.dispatch', 'click script dispatched', fields],
      },
    ])
  })

  it('leaves the page’s own console doing what it did', () => {
    const { scope, seen } = fakePage()
    installRecordTap(scope, RECORD_BINDING)
    const fields = { a: 1 }
    scope.console.warn('w', fields)
    expect(seen.native).toEqual([['warn', 'w', fields]])
    expect(seen.native[0][2]).toBe(fields)
  })

  it('names the level each call was made at', () => {
    const { scope, seen } = fakePage()
    installRecordTap(scope, RECORD_BINDING)
    for (const level of ['debug', 'log', 'info', 'warn', 'error']) scope.console[level](level)
    expect(seen.sent.map((r) => r.level)).toEqual(['debug', 'log', 'info', 'warn', 'error'])
  })

  it('copies what JSON cannot carry into something it can', () => {
    const { scope, seen } = fakePage()
    installRecordTap(scope, RECORD_BINDING)
    const loop = { name: 'loop' }
    loop.self = loop
    scope.console.error(
      new TypeError('boom'),
      { fn: () => 1, big: 10n, list: [1, { deep: true }] },
      loop,
    )
    const [error, mixed, cyclic] = seen.sent[0].args
    expect(error).toEqual({ name: 'TypeError', message: 'boom' })
    expect(mixed).toEqual({ fn: '() => 1', big: '10', list: [1, { deep: true }] })
    // A cycle is cut at a fixed depth rather than followed for ever.
    expect(JSON.stringify(cyclic)).toContain('[deeper]')
  })

  it('never lets a record it cannot send stop the page logging', () => {
    const { scope, seen } = fakePage()
    scope[RECORD_BINDING] = () => {
      throw new Error('the driver went away')
    }
    installRecordTap(scope, RECORD_BINDING)
    expect(() => scope.console.info('still here')).not.toThrow()
    expect(seen.native).toEqual([['info', 'still here']])
  })

  it('does nothing in a page the driver planted no receiver in', () => {
    const { scope } = fakePage()
    delete scope[RECORD_BINDING]
    const before = scope.console.info
    installRecordTap(scope, RECORD_BINDING)
    expect(scope.console.info).toBe(before)
  })

  it('works as the text that is run in the page', () => {
    const { scope, seen } = fakePage()
    // The page runs the source with its global object as `globalThis`.
    new Function('globalThis', RECORD_TAP_SOURCE)(scope)
    scope.console.log('from text', { n: 1 })
    expect(seen.sent[0].args).toEqual(['from text', { n: 1 }])
  })
})
