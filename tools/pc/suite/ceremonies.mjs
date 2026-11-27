// The sounds around the calls: bells, and the clips the app plays by name.
//
// A call is logged with its length and matched to an element by time. These
// are simpler and stricter: the app logs the clip's name (`asset`), the
// element's file has the same name, and the two must meet within a few
// milliseconds.
import { fieldsOf, recordsOf } from './capture.mjs'
import { clipName, stopReasonOf } from './plays.mjs'

/** How long after the app dispatched a named clip its element's `play()` may fall. */
export const NAMED_MATCH_WINDOW_MS = 250
/** How far from a round boundary its bell's dispatch may be. They are sent in the same pass. */
export const BELL_AT_BOUNDARY_MS = 500
/** The boundaries a bell marks: a round starting, a round ending, the workout finishing. */
export const BELL_TRANSITIONS = ['work-entered', 'rest-entered', 'completed']

/**
 * @typedef {object} NamedClip a clip the app played by name, and what was heard of it
 * @property {string} asset the name the app logged — `bell`, a lead-in's id, …
 * @property {number} dispatchMs when the app sent it to play, on the page's clock
 * @property {number} volume the volume it was played at; 0 is silence on purpose
 * @property {import('./sound.mjs').ElementPlay | null} play the element play that was it
 * @property {number | null} firstSoundMs
 * @property {number | null} lastSoundMs
 * @property {string | null} stop why the play stopped (`stopReasonOf`)
 * @property {number | null} stoppedShortMs how far short of its end it stopped
 */

/**
 * Every clip the app logged playing by name, with the element play that was
 * it: the same file name, started in the same moment, not already taken.
 *
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 * @param {import('./sound.mjs').ElementPlay[]} plays
 * @param {object} context
 * @param {Set<import('./sound.mjs').ElementPlay | null>} context.claimed plays already matched to a call or lead-in; added to
 * @param {number[]} context.appStops
 * @param {number} context.truncationMs
 * @returns {NamedClip[]}
 */
export function namedClips(records, plays, { claimed, appStops, truncationMs }) {
  const clips = []
  for (const record of recordsOf(records, 'workout.voice.play')) {
    const f = fieldsOf(record)
    if (
      record.args[1] !== 'clip playing' ||
      typeof f.asset !== 'string' ||
      !Number.isFinite(f.dispatchMs)
    )
      continue
    const play =
      plays
        .filter(
          (p) =>
            !claimed.has(p) &&
            clipName(p.src) === f.asset &&
            p.playAtMs >= f.dispatchMs - 5 &&
            p.playAtMs <= f.dispatchMs + NAMED_MATCH_WINDOW_MS,
        )
        .sort(
          (a, b) => Math.abs(a.playAtMs - f.dispatchMs) - Math.abs(b.playAtMs - f.dispatchMs),
        )[0] ?? null
    if (play) claimed.add(play)
    clips.push({
      asset: f.asset,
      dispatchMs: f.dispatchMs,
      volume: f.volume ?? 1,
      play,
      firstSoundMs: play?.sound[0]?.startMs ?? null,
      lastSoundMs: play?.sound.at(-1)?.endMs ?? null,
      stop: play ? stopReasonOf(play, { appStops, truncationMs }) : null,
      stoppedShortMs:
        play && play.durationMs !== null && play.stoppedPositionMs !== null
          ? play.durationMs - play.stoppedPositionMs
          : null,
    })
  }
  return clips
}

/** A named clip played to be heard that made no sound. Volume 0 is silence on purpose. */
export const isSilent = (clip) => clip.volume > 0 && clip.firstSoundMs === null
/** A named clip stopped before its end with nothing to account for it. */
export const isCut = (clip) =>
  clip.volume > 0 && (clip.stop === 'unexplained' || clip.stop === 'replayed')

/**
 * The bell at each round boundary.
 *
 * A round starting, a round ending and the workout finishing are each marked
 * by a bell, sent in the same pass of the app's loop as the boundary itself.
 * So every such boundary must have one, and it must sound.
 *
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 * @param {NamedClip[]} named
 */
export function bellsAt(records, named) {
  const bells = named.filter((clip) => clip.asset === 'bell')
  const taken = new Set()
  return recordsOf(records, 'workout.round.boundary')
    .map(fieldsOf)
    .filter((boundary) => BELL_TRANSITIONS.includes(boundary.transition))
    .map((boundary) => {
      const bell =
        bells
          .filter(
            (b) =>
              !taken.has(b) &&
              Math.abs(b.dispatchMs - boundary.monotonicTimeMs) <= BELL_AT_BOUNDARY_MS,
          )
          .sort(
            (a, b) =>
              Math.abs(a.dispatchMs - boundary.monotonicTimeMs) -
              Math.abs(b.dispatchMs - boundary.monotonicTimeMs),
          )[0] ?? null
      if (bell) taken.add(bell)
      return {
        transition: boundary.transition,
        roundIndex: boundary.roundIndex,
        atMs: boundary.monotonicTimeMs,
        bell,
        /** The bell's first sound after the boundary it marks. */
        soundsAfterMs:
          bell && bell.firstSoundMs !== null ? bell.firstSoundMs - boundary.monotonicTimeMs : null,
      }
    })
}
