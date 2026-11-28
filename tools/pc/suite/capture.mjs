// A PC run, saved the way the tablet suite saves one.
//
// The tablet suite's evidence is `logcat.txt`: `adb logcat -v time` lines,
// each the app's log record as React Native's console lays it out. Every
// verifier in `tools/analysis/` reads that layout. So the PC writes the same
// one, and the same verifiers judge it — no second parser, no second judge.
//
// Two things differ on purpose, and both are visible in the file:
//
// - the process tag is `PunchCraftWeb`, not `ReactNativeJS`. No verifier
//   reads the tag, and it is how a capture with no QA run record in it still
//   says it is the PC's (`capturePlatform` in `tools/analysis/logcat.mjs`).
// - the clock starts at 00:00:00.000 with the first record, on one date,
//   and simply counts up. The verifiers use differences only. (They used to
//   read the time of day alone, which a real clock crossing midnight would
//   have broken; the capture clock now runs through midnight, and this
//   layout stays as it is because every stored run is written in it.)
import { WEB_CAPTURE_TAG } from '../../analysis/logcat.mjs'

/** `[INFO] workout.round.boundary` — the app's own records, and nothing else's. */
const APP_RECORD = /^\[([A-Z]+)\] ([\w.-]+)$/

/**
 * Whether a console call is one of the app's log records. The rest — a
 * library's warning, a stray `console.log` — is kept out of the capture: a
 * line that does not open a record is glued onto the one before it by the
 * verifiers' parser, and would put words in its mouth.
 *
 * @param {import('../app/recordTap.mjs').PageRecord} record
 */
export function isAppRecord(record) {
  return typeof record.args[0] === 'string' && APP_RECORD.test(record.args[0])
}

/** The record's code, e.g. `workout.round.boundary`. Null for anything else. */
export function codeOf(record) {
  const match = typeof record.args[0] === 'string' ? APP_RECORD.exec(record.args[0]) : null
  return match ? match[2] : null
}

/** The record's fields — the object the app logged beside its message. */
export function fieldsOf(record) {
  const fields = record.args[2]
  return fields !== null && typeof fields === 'object'
    ? /** @type {Record<string, any>} */ (fields)
    : {}
}

/** Every app record with this code, in order. */
export function recordsOf(records, code) {
  return records.filter((record) => codeOf(record) === code)
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

// Spelled out rather than written as an escape: this file reaches the page
// of a reader through several layers that each like to eat a backslash.
const BACKSLASH = String.fromCharCode(92)

/** A string's body between single quotes, as the console escapes it. */
const escaped = (text) =>
  text
    .replaceAll(BACKSLASH, BACKSLASH + BACKSLASH)
    .replaceAll("'", BACKSLASH + "'")
    .replaceAll(String.fromCharCode(10), BACKSLASH + 'n')

/**
 * One value, as React Native's console prints it: strings in single quotes,
 * an object on one line until it is long, then a field per line.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function render(value) {
  if (typeof value === 'string') {
    return `'${escaped(value)}'`
  }
  if (value === null || typeof value !== 'object') return String(value)
  const array = Array.isArray(value)
  const parts = array
    ? value.map((item) => indentNested(render(item)))
    : Object.keys(value).map(
        (key) => `${IDENTIFIER.test(key) ? key : render(key)}: ${indentNested(render(value[key]))}`,
      )
  if (parts.length === 0) return array ? '[]' : '{}'
  const [open, close] = array ? ['[', ']'] : ['{', '}']
  // The console's own rule: past sixty characters, one field to a line.
  const length = parts.reduce((sum, part) => sum + part.length + 1, 0)
  return length > 60
    ? `${open} ${parts.join(',\n  ')} ${close}`
    : `${open} ${parts.join(', ')} ${close}`
}

/** A nested value's later lines sit two spaces further in. */
const indentNested = (text) => text.replaceAll('\n', '\n  ')

const pad = (n, width = 2) => String(n).padStart(width, '0')

/** `HH:MM:SS.mmm` for a number of milliseconds since the capture began. */
function clockText(elapsedMs) {
  const ms = Math.max(0, Math.round(elapsedMs))
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor(ms / 60_000) % 60
  const seconds = Math.floor(ms / 1000) % 60
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(ms % 1000, 3)}`
}

/**
 * The capture as `logcat.txt`.
 *
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 * @param {{ pid?: number }} [options]
 * @returns {string}
 */
export function logcatText(records, { pid = 1 } = {}) {
  const app = records.filter(isAppRecord)
  if (app.length === 0) return ''
  const start = app[0].wallMs
  const day = new Date(start)
  const date = `${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`
  const lines = []
  for (const record of app) {
    const letter = record.level === 'error' ? 'E' : record.level === 'warn' ? 'W' : 'I'
    const prefix = `${date} ${clockText(record.wallMs - start)} ${letter}/${WEB_CAPTURE_TAG}(${String(pid).padStart(5)}): `
    const body = record.args.map(render).join(', ')
    for (const line of body.split('\n')) lines.push(prefix + line)
  }
  return lines.join('\n') + '\n'
}

/** Everything the page printed that is not one of the app's records, one call per line. */
export function otherConsoleText(records) {
  return records
    .filter((record) => !isAppRecord(record))
    .map(
      (record) =>
        `${record.level}: ${record.args.map((arg) => (typeof arg === 'string' ? arg : render(arg))).join(' ')}`,
    )
    .join('\n')
}
