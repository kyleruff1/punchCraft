/**
 * How the PC build reads a player's status for the timing observer — Metro
 * picks this over `observedStatus.ts` for the web build.
 *
 * expo-audio's browser players do not mean what the tablet's mean by
 * `playing`. A player reports `playing: true` from the element's `play`
 * event, which is the request, not the sound: the playhead is still at 0 and
 * may stay there while a clip downloads. A playlist reports `playing: true`
 * in every status from the moment `play()` is called. Read as the tablet's
 * are, "started" meant "asked to start" — and a clip on a download-first
 * player looked 4 ms long, because the next thing its player said was
 * `playing: false`, from the `loadeddata` of the element it had just swapped
 * in (measured 2026-11-26, quick-one-two round 1).
 *
 * So, until a play has its onset, a status counts only once the playhead
 * has moved:
 *
 * - not moved: ignored. It says play was asked for, which the dispatch
 *   stamp already records.
 * - moved and playing: the onset. The status carries the position, so
 *   `positionAtOnsetMs` says how far in the sound already was — a browser
 *   reports position about four times a second, and whoever wants the
 *   moment the sound began subtracts it. Nothing is back-dated here.
 * - moved and already stopped: a clip that began and ended between two
 *   reports. It is read as both, in order — otherwise a short clip would
 *   never be seen to start, and would close as a timeout.
 *
 * "Moved" is a position past 0, or for a playlist any track after the
 * first: a later track legitimately starts at 0.
 *
 * Once a play has its onset every status is passed on untouched: a stop is
 * a stop wherever the playhead is.
 */
import type { StatusLike, StatusReading } from './PlaybackObserver'

function hasMoved(status: StatusLike): boolean {
  return (status.currentTime ?? 0) > 0 || (status.currentIndex ?? 0) > 0
}

export const observedStatusReading: StatusReading | undefined = (status, started) => {
  if (started) return [status]
  if (!hasMoved(status)) return []
  if (status.playing === true) return [status]
  return [{ ...status, playing: true, didJustFinish: false }, status]
}
