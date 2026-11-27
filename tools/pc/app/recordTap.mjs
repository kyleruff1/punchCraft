// The page's log, whole.
//
// The DevTools protocol reports a console call with a *preview* of each
// object argument: its first five fields. The app's log records are objects,
// and the fields the verifiers read are rarely among the first five — a
// dispatch record carries twelve. So a driver that needs the records
// installs this in the page before any of the app's code runs: every console
// call is also handed, complete, to a function the driver planted.
//
// The work done in the page is kept to a copy and one JSON string. The page
// is the thing being timed; laying the record out for a person to read is
// done afterwards, outside it.

/** The name of the function the driver plants in the page to receive records. */
export const RECORD_BINDING = '__pcRecord'

/**
 * @typedef {object} PageRecord one console call
 * @property {number} wallMs the page's clock when it was made, as an epoch time (`timeOrigin + now`)
 * @property {number} monoMs `performance.now()` when it was made — the app's own monotonic clock
 * @property {'debug' | 'log' | 'info' | 'warn' | 'error'} level
 * @property {unknown[]} args the arguments, copied
 */

/**
 * Wrap the console of `scope` so each call is also sent to `scope[binding]`.
 *
 * Self-contained on purpose: it is turned into text and run in the page, so
 * it can close over nothing in this file.
 *
 * @param {any} scope the page's global object
 * @param {string} binding
 */
export function installRecordTap(scope, binding) {
  const send = scope[binding]
  if (typeof send !== 'function') return
  const MAX_DEPTH = 6
  /** A copy that JSON can carry: no cycles past the depth, no functions. */
  const plain = (value, depth) => {
    if (value === null || value === undefined) return value
    const type = typeof value
    if (type === 'bigint' || type === 'function' || type === 'symbol') return String(value)
    if (type !== 'object') return value
    if (value instanceof Error) return { name: value.name, message: value.message }
    if (depth >= MAX_DEPTH) return '[deeper]'
    if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1))
    const out = {}
    for (const key of Object.keys(value)) out[key] = plain(value[key], depth + 1)
    return out
  }
  const clock = scope.performance
  for (const level of ['debug', 'log', 'info', 'warn', 'error']) {
    const native = scope.console[level]
    scope.console[level] = function tapped(...args) {
      try {
        const monoMs = clock.now()
        send(
          JSON.stringify({
            wallMs: clock.timeOrigin + monoMs,
            monoMs,
            level,
            args: args.map((arg) => plain(arg, 0)),
          }),
        )
      } catch {
        // A record that cannot be copied is lost to the driver; the page's
        // own console still gets it, on the line below.
      }
      return native.apply(scope.console, args)
    }
  }
}

/** `installRecordTap` as text, to run in a page before anything else does. */
export const RECORD_TAP_SOURCE = `(${installRecordTap.toString()})(globalThis, ${JSON.stringify(RECORD_BINDING)})`
