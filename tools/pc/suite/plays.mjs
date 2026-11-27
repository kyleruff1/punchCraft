// What kind of clip an element played, and why it stopped.
//
// The sound tap reports plays per `<audio>` element. Two questions have to be
// answered about each before it can be judged, and the answers were wrong
// while only calls were judged:
//
// - Which clip was it? Bells, the intro, the countdown and the rest line play
//   from the build's own files, and the file name says which. A call plays
//   from a downloaded copy with no name — and its player starts on an element
//   with no source at all, which never sounds and is not a clip.
// - Why did it stop short, if it did? The app stops the countdown itself when
//   the bell rings, and says so in its log. A round-1 run ends three seconds
//   into the rest, mid-sentence. Neither is a clip being cut.

/** The clip's name: its file name up to the first dot. Empty for an element with no source. */
export const clipName = (src) => String(src ?? '').split('.')[0]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * What an element was playing, from its source's file name.
 *
 * `phantom` is an element that never had a source: the one a download-first
 * player starts on before it swaps to the element that sounds. `downloaded`
 * is a clip fetched first and played from memory — the calls, and most
 * lead-ins — which has an id where a name would be.
 *
 * @param {string} src the last part of the element's address
 * @returns {'phantom' | 'bell' | 'silence' | 'intro' | 'countdown' | 'rest-line' | 'lead-in' | 'downloaded' | 'other'}
 */
export function clipKind(src) {
  const name = clipName(src)
  if (name === '') return 'phantom'
  if (name === 'bell') return 'bell'
  if (/^silence-\d+$/.test(name)) return 'silence'
  if (name.startsWith('intro-')) return 'intro'
  if (name.startsWith('warn-')) return 'countdown'
  if (name.startsWith('rr-')) return 'rest-line'
  if (name.startsWith('li-')) return 'lead-in'
  if (UUID.test(name)) return 'downloaded'
  return 'other'
}

/** The log lines in which the app says it stopped a ceremony itself. */
const APP_STOPS = [
  ['workout.intro', 'intro stopped'],
  ['workout.warn', 'round warning stopped'],
  ['workout.recovery', 'recovery stopped'],
]

/**
 * When the app logged that it stopped a ceremony, on the page's clock.
 *
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 * @returns {number[]}
 */
export function appStopTimes(records) {
  return records
    .filter((r) =>
      APP_STOPS.some(([code, message]) => r.args[0] === `[INFO] ${code}` && r.args[1] === message),
    )
    .map((r) => r.monoMs)
}

/** How near the app's "stopped" line must be to an element's stop to be the reason for it. */
export const APP_STOP_WINDOW_MS = 100

/**
 * Why a play stopped.
 *
 * - `ended` — it reached its own end, to within the allowance;
 * - `app-stopped` — short of its end, at a moment the app logged stopping it;
 * - `run-ended` — it had not stopped when the capture did;
 * - `replayed` — short of its end because its element was played again;
 * - `unknown` — it stopped, and its length or position was never reported;
 * - `unexplained` — short of its end, and nothing in the log says why.
 *
 * Only the last two of the short ones are a clip being cut.
 *
 * @param {import('./sound.mjs').ElementPlay} play
 * @param {{ appStops: number[], truncationMs: number }} context
 */
export function stopReasonOf(play, { appStops, truncationMs }) {
  if (play.stoppedBy === null) return 'run-ended'
  const known = play.durationMs !== null && play.stoppedPositionMs !== null
  if (known && play.durationMs - play.stoppedPositionMs <= truncationMs) return 'ended'
  if (appStops.some((at) => Math.abs(at - play.stoppedAtMs) <= APP_STOP_WINDOW_MS))
    return 'app-stopped'
  if (play.stoppedBy === 'replayed') return 'replayed'
  return known ? 'unexplained' : 'unknown'
}
