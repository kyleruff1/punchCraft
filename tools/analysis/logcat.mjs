/**
 * Logcat record parsing shared by every analyzer in this directory
 * (GH #292, plan C5 — factored out of verify-first-round.mjs so
 * verify-suite.mjs and observed-summary.mjs read the same shapes).
 *
 * `adb logcat -v time` lines look like
 *   `MM-DD HH:MM:SS.mmm I/ReactNativeJS(pid): '[workout.x] message', { field: 1,`
 * and React Native's ConsoleSink wraps an object payload across several
 * lines with the SAME prefix. `stitchLogRecords` collapses those into one
 * body per record so `extractField` can see a field that sits two lines
 * below its event tag.
 */

/** `adb logcat -v time` prefix: date, time, level/tag(pid), body. */
export const LOG_PREFIX = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+\w\/\w+\(\s*\d+\):\s*(.*)$/

/**
 * The other layout the captures use — `adb logcat -v epoch` (threadtime with
 * epoch seconds): `1788036159.021  6644  6780 I ReactNativeJS: body`.
 *
 * Every `log.txt` written by a mic-monitored session is in this layout, and
 * until 2026-11-26 nothing here could read it: `LOG_PREFIX` did not match a
 * single line, so the correlator — which says it accepts `log.txt` — parsed
 * those sessions to zero records.
 */
export const EPOCH_PREFIX = /^\s*(\d{9,11})\.(\d{3})\s+(\d+)\s+\d+\s+\w\s+[\w.-]+:\s?(.*)$/

/** The pid in a `-v time` prefix, which `LOG_PREFIX` does not capture. */
const TIME_PID = /\(\s*(\d+)\):/

/**
 * Split one line into `{ dateStr, timeStr, pid, epochMs, body }`, or null.
 *
 * An epoch line is given the `dateStr` / `timeStr` a `-v time` line would
 * have carried (UTC), so every consumer written against that layout reads it
 * unchanged. Only differences between timestamps are ever used.
 */
export function splitLogLine(rawLine) {
  const m = LOG_PREFIX.exec(rawLine)
  if (m) {
    return {
      dateStr: m[1],
      timeStr: m[2],
      pid: Number(TIME_PID.exec(rawLine)?.[1] ?? NaN),
      epochMs: undefined,
      body: m[3],
    }
  }
  const e = EPOCH_PREFIX.exec(rawLine)
  if (!e) return null
  const epochMs = Number(e[1]) * 1000 + Number(e[2])
  const iso = new Date(epochMs).toISOString() // YYYY-MM-DDTHH:MM:SS.mmmZ
  return {
    dateStr: iso.slice(5, 10),
    timeStr: iso.slice(11, 23),
    pid: Number(e[3]),
    epochMs,
    body: e[4],
  }
}

/**
 * Milliseconds since midnight for a `-v time` timestamp — the time of day
 * alone. It wraps at midnight, so it is not a clock: read a record's `ts`
 * (set by `stitchLogRecords`) for anything that takes a difference.
 */
export function parseTimestampMs(dateStr, timeStr) {
  const [hh, mm, ss] = timeStr.split(':')
  const [ssI, ms] = ss.split('.')
  return Number(hh) * 3600_000 + Number(mm) * 60_000 + Number(ssI) * 1000 + Number(ms)
}

/** Extract one field from a JSON-like body: `key: 'str'`, `key: "str"` or `key: 12.5`. */
export function extractField(body, key) {
  const re = new RegExp(`${key}:\\s*'([^']*)'|${key}:\\s*"([^"]*)"|${key}:\\s*([0-9.eE+-]+)`)
  const m = body.match(re)
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined
}

/** `extractField`, coerced to a number. `undefined` stays `undefined`. */
export function numField(body, key) {
  const v = extractField(body, key)
  return v === undefined ? undefined : Number(v)
}

/** `extractField` for a boolean printed bare (`dev: false`) or quoted. */
export function boolField(body, key) {
  const m = body.match(new RegExp(`${key}:\\s*'?(true|false)'?`))
  return m ? m[1] === 'true' : undefined
}

/**
 * Stitch multi-line records into `{ dateStr, timeStr, body }` triples.
 *
 * A body that starts with `'[` opens a new record; any other prefixed line
 * is a continuation of the record in progress. A line without the prefix
 * ENDS the record in progress — it is flushed, never discarded (the last
 * record of every archived capture was lost before that rule existed).
 */
export function stitchLogRecords(logcatText) {
  const lines = logcatText.split(/\r?\n/)
  const records = []
  let current = null
  for (const rawLine of lines) {
    const line = splitLogLine(rawLine)
    if (!line) {
      if (current) records.push(current)
      current = null
      continue
    }
    const { dateStr, timeStr, pid, epochMs, body } = line
    const startsWithTag = body.startsWith("'[")
    if (startsWithTag || current === null) {
      if (current) records.push(current)
      // `ts` is the capture clock, set for every record once all are stitched.
      current = { dateStr, timeStr, pid, epochMs, body, ts: 0 }
    } else {
      current.body += ' ' + body.trim()
    }
  }
  if (current) records.push(current)
  stampCaptureClock(records)
  return records
}

const DAY_MS = 86_400_000

/**
 * Give every record its `ts`: milliseconds on one clock that runs on through
 * midnight.
 *
 * A capture that stays inside one day reads exactly as it always did —
 * milliseconds since midnight — so nothing stored changes. When the DATE on a
 * line differs from the line before it, the day has turned: forward if the
 * time of day fell (23:59 → 00:00), back if it rose, which is a line from
 * just before midnight written after one from just after it. Only the date
 * changing can turn the day, so a long quiet stretch inside one day is never
 * taken for a wrap; and no calendar is consulted, so the end of a month, of
 * February and of the year are all the same case.
 *
 * Round 1 is four minutes and never met midnight. A suite of whole workouts
 * on an emulator runs for hours and will.
 */
function stampCaptureClock(records) {
  let day = 0
  let previous = null
  for (const record of records) {
    const ofDay = parseTimestampMs(record.dateStr, record.timeStr)
    if (previous !== null && record.dateStr !== previous.dateStr) day += ofDay < previous.ofDay ? 1 : -1
    record.ts = day * DAY_MS + ofDay
    previous = { dateStr: record.dateStr, ofDay }
  }
}

/**
 * The event code of a stitched record, or undefined.
 *
 * `ConsoleSink` (src/diagnostics/logger.ts) writes
 * `console.info('[INFO] workout.voice.play', 'clip playing', {…})`, which
 * reaches logcat as `'[INFO] workout.voice.play', 'clip playing', { … }` —
 * the LEVEL is what sits in the brackets and the code follows it. A matcher
 * built on `'[<code>]` finds nothing on a real capture while passing happily
 * against a fixture written the same wrong way; that cost one release drive.
 */
export function recordTag(body) {
  const m = body.match(/^'\[[A-Z]+\]\s+([a-zA-Z0-9_.-]+)'/)
  return m ? m[1] : undefined
}

/**
 * Legacy log-code prefix. Event codes were renamed `puncheokie.*` ->
 * `workout.*` when the Puncheoke instrument was forked out, but the ~319
 * captures under tools/analysis/{sessions,suites,monitor,listen,batches}
 * were recorded BEFORE that rename and still carry the old prefix. Those
 * captures are the baselines every regression comparison rests on — the
 * breath-floor A/B and the pre/post-floor suites among them — so the matcher
 * accepts either spelling rather than silently returning zero rows on
 * historical data. Drop this once no capture in use predates the rename.
 */
const LEGACY_TAG_PREFIX = 'puncheokie.'
const CURRENT_TAG_PREFIX = 'workout.'

/** A record body whose event code carries the pre-fork prefix. */
const LEGACY_HEAD = /^('\[[A-Z]+\]\s+)puncheokie\./

/**
 * A stitched record's body with its event code in the CURRENT spelling.
 *
 * For a consumer that matches codes by substring instead of through
 * `recordsWithTag` — the first-round correlator does, because the ORDER of
 * its checks is load-bearing (`voice.playFailed` contains `voice.play`).
 * Until 2026-11-25 that consumer matched the current spelling only, so on
 * every capture recorded before the rename it parsed to nothing and reported
 * "no calls dispatched": the silent-zero-rows failure the aliasing here was
 * written to prevent, in the one tool that judges a stored capture.
 *
 * Only the leading code is rewritten. `puncheokie` anywhere else in the body
 * — a route, a file path, a workout id — is content, and stays.
 */
export function withCurrentTag(body) {
  return body.replace(LEGACY_HEAD, `$1${CURRENT_TAG_PREFIX}`)
}

/** Every spelling of `tag` that should match, newest first. */
function tagAliases(tag) {
  if (!tag.startsWith(CURRENT_TAG_PREFIX)) return [tag]
  return [tag, LEGACY_TAG_PREFIX + tag.slice(CURRENT_TAG_PREFIX.length)]
}

/**
 * Stitched records whose code is EXACTLY `tag`, each with its `ts` (the
 * capture's clock: ms since midnight, running on through it). Exact, so
 * `workout.qa.run` never swallows `workout.qa.run.blocked` or `.duplicate`.
 *
 * Matches the pre-fork `puncheokie.*` spelling too — see LEGACY_TAG_PREFIX.
 */
export function recordsWithTag(logcatText, tag) {
  const accepted = new Set(tagAliases(tag))
  return stitchLogRecords(logcatText)
    .filter((r) => accepted.has(recordTag(r.body)))
    .map((r) => ({ ts: r.ts, body: r.body }))
}

/**
 * The process tag a capture from the PC version is written under, where the
 * tablet's is `ReactNativeJS`. Nothing in this file reads the tag while
 * parsing — any word is accepted — so this is the capture saying where it
 * came from even when it holds no `workout.qa.run` record to say it in words.
 */
export const WEB_CAPTURE_TAG = 'PunchCraftWeb'

/** A `-v time` line under that tag: `MM-DD HH:MM:SS.mmm I/PunchCraftWeb(pid):`. */
const WEB_TAGGED_LINE = new RegExp(String.raw`^\d{2}-\d{2}\s+\S+\s+\w\/${WEB_CAPTURE_TAG}\(`, 'm')

/**
 * What `capturePlatform` calls an Android emulator. It is Android by name and
 * a PC by everything the question is asked for: its processor and its audio
 * path are the PC's.
 */
export const EMULATOR_PLATFORM = 'android-emulator'

/**
 * Which platform wrote a capture: `'android'` (the tablet), `'web'`,
 * `'android-emulator'`, or whatever else the app named.
 *
 * The QA run record says so in its own `platform` field — but only since
 * 2026-11-26, and only when the capture holds one. So two more rules follow,
 * in order: a capture written under `WEB_CAPTURE_TAG` is the PC's; and a
 * capture that says nothing at all is the tablet's, because every capture
 * taken before that date is.
 *
 * An Android capture is then asked one more thing: the record's `emulator`
 * field (since 2026-11-27, `src/diagnostics/deviceKind.ts`). An emulator's
 * capture was once taken for the tablet's, and tablet constants proposed from
 * it (findings doc, N-19).
 *
 * **What this cannot see:** an emulator running a build from before that
 * field existed says nothing, and is read as the tablet. The verify suite
 * closes that from the other side — it asks the device itself
 * (`isEmulatorDevice` in `verify-suite.mjs`).
 */
export function capturePlatform(logcatText) {
  const run = recordsWithTag(logcatText, 'workout.qa.run').at(-1)
  const named = run ? extractField(run.body, 'platform') : undefined
  const platform = named ?? (WEB_TAGGED_LINE.test(logcatText) ? 'web' : 'android')
  if (platform === 'android' && run && boolField(run.body, 'emulator') === true) return EMULATOR_PLATFORM
  return platform
}
