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

/** The ceremonies the app plays as several clips back to back, and the lines it logs for each. */
const CEREMONIES = [
  { name: 'intro', code: 'workout.intro', loaded: 'intro loaded', playing: 'intro playing' },
  {
    name: 'countdown',
    code: 'workout.warn',
    loaded: 'round warning prepared',
    playing: 'round warning playing',
  },
  {
    name: 'rest-line',
    code: 'workout.recovery',
    loaded: 'recovery loaded',
    playing: 'recovery playing',
  },
]

/** How far from the app's "playing" line the first track's `play()` may be. They are logged together. */
export const CHAIN_START_WINDOW_MS = 250
/** How long after one track stops the next may start. It is started from the handler of the first's end. */
export const CHAIN_LINK_WINDOW_MS = 250

/**
 * @typedef {object} Track one clip of a ceremony
 * @property {string} name the clip's file name, without its hash
 * @property {string} kind `silence` for a gap; otherwise what the clip is
 * @property {import('./sound.mjs').ElementPlay} play
 * @property {string} stop why it stopped (`stopReasonOf`)
 * @property {number | null} stoppedShortMs how far short of its end it stopped
 *
 * @typedef {object} Ceremony one intro, countdown or rest line, as it was heard
 * @property {string} name `intro`, `countdown` or `rest-line`
 * @property {number} ordinal which one of its kind in the run, from 1
 * @property {number} playingAtMs when the app logged starting it
 * @property {number | null} expectedTracks how many clips the app said it had loaded
 * @property {Track[]} tracks the clips found, in order
 * @property {number | null} firstSoundMs
 * @property {number | null} lastSoundMs
 * @property {string} outcome `complete`, `app-stopped`, `run-ended` or `broken`
 * @property {string | null} why what is wrong with it, when `broken`
 */

/**
 * Every intro, countdown and rest line, found by following its chain.
 *
 * The app logs "playing" in the same moment as it starts the first clip.
 * Each next clip is started from the handler of the last one's end, so it
 * begins where that one stopped. Following that link — and not the file
 * names, or a count of gaps — is what finds the clips whatever they are:
 * an intro may open on a silence, and a gap with no silence file is skipped.
 *
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 * @param {import('./sound.mjs').ElementPlay[]} plays
 * @param {object} context
 * @param {Set<import('./sound.mjs').ElementPlay | null>} context.claimed plays already matched; added to
 * @param {number[]} context.appStops
 * @param {number} context.truncationMs
 * @returns {Ceremony[]}
 */
export function ceremoniesOf(records, plays, { claimed, appStops, truncationMs }) {
  const free = (p) => !claimed.has(p) && p.kind !== 'phantom'
  const found = []
  for (const kind of CEREMONIES) {
    const lines = recordsOf(records, kind.code)
    let ordinal = 0
    for (const line of lines.filter((r) => r.args[1] === kind.playing)) {
      ordinal += 1
      // The clip count is in the line that loaded it, which comes first.
      const loaded = lines
        .filter((r) => r.args[1] === kind.loaded && r.monoMs <= line.monoMs)
        .at(-1)
      const expectedTracks = loaded ? (fieldsOf(loaded).tracks ?? null) : null
      const tracks = []
      let next = plays
        .filter((p) => free(p) && Math.abs(p.playAtMs - line.monoMs) <= CHAIN_START_WINDOW_MS)
        .sort((a, b) => Math.abs(a.playAtMs - line.monoMs) - Math.abs(b.playAtMs - line.monoMs))[0]
      while (next && (expectedTracks === null || tracks.length < expectedTracks)) {
        claimed.add(next)
        const stop = stopReasonOf(next, { appStops, truncationMs })
        tracks.push({
          name: clipName(next.src),
          kind: next.kind,
          play: next,
          stop,
          stoppedShortMs:
            next.durationMs !== null && next.stoppedPositionMs !== null
              ? next.durationMs - next.stoppedPositionMs
              : null,
        })
        // Only a clip that reached its end hands on to the next.
        if (stop !== 'ended') break
        const from = next
        next = plays
          .filter(
            (p) =>
              free(p) &&
              p.id !== from.id &&
              p.playAtMs >= from.stoppedAtMs - 20 &&
              p.playAtMs <= from.stoppedAtMs + CHAIN_LINK_WINDOW_MS,
          )
          .sort((a, b) => a.playAtMs - b.playAtMs)[0]
      }
      found.push({
        name: kind.name,
        ordinal,
        playingAtMs: line.monoMs,
        expectedTracks,
        tracks,
        ...heardOf(tracks),
        ...outcomeOf(tracks, expectedTracks),
      })
    }
  }
  return found.sort((a, b) => a.playingAtMs - b.playingAtMs)
}

/** A ceremony's first and last sound, across its clips. */
function heardOf(tracks) {
  const stretches = tracks.flatMap((t) => t.play.sound)
  return {
    firstSoundMs: stretches[0]?.startMs ?? null,
    lastSoundMs: stretches.at(-1)?.endMs ?? null,
  }
}

/** Whether a ceremony played as the app said it would, and if not, how. */
function outcomeOf(tracks, expectedTracks) {
  const broken = (why) => ({ outcome: 'broken', why })
  if (tracks.length === 0) return broken('no audio element answered when the app started it')
  for (const track of tracks) {
    const spoken = track.kind !== 'silence'
    if (
      spoken &&
      track.play.volume > 0 &&
      track.play.sound.length === 0 &&
      track.stop === 'ended'
    ) {
      return broken(`its clip ${track.name} was played and made no sound`)
    }
    if (track.stop === 'failed') {
      return broken(
        `its clip ${track.name} could not be played — the browser reported ${track.play.error}`,
      )
    }
    if (track.stop === 'unexplained' || track.stop === 'replayed') {
      return broken(
        `its clip ${track.name} was stopped ${Math.round(track.stoppedShortMs)} ms before its end, and the log does not say why`,
      )
    }
  }
  const last = tracks.at(-1)
  if (last.stop === 'app-stopped') return { outcome: 'app-stopped', why: null }
  if (last.stop === 'run-ended' || last.stop === 'unknown')
    return { outcome: 'run-ended', why: null }
  if (expectedTracks !== null && tracks.length < expectedTracks) {
    return broken(
      `${tracks.length} of its ${expectedTracks} clips played: nothing followed ${last.name}`,
    )
  }
  return { outcome: 'complete', why: null }
}

const SAID = { intro: 'intro', countdown: 'countdown', 'rest-line': 'rest line' }
/** "countdown 2" — which one, for a list in a report. */
export const ceremonyLabel = (c) => `${SAID[c.name]} ${c.ordinal}`

/**
 * What the ceremonies of a run add up to.
 *
 * - `broken` — a ceremony that did not play as the app said it would. Hard.
 * - `cutByApp` — the app stopped one while it still had sound to give: the
 *   bell cutting the countdown, the round starting over the intro. Soft.
 * - `talkedOver` — a rest line still sounding when the countdown began. Soft.
 * - `mixedVolumes` — one ceremony whose clips played at different volumes.
 *   Soft, and aimed at the browser: its playlist sets a new volume on the
 *   clip that is playing and not on the one it has already lined up.
 * - `countdownToBell` — the gap from a countdown's last word to the first
 *   sound of the bell it leads into. Reported.
 *
 * @param {Ceremony[]} ceremonies
 * @param {ReturnType<typeof bellsAt>} boundaries
 * @param {number} truncationMs
 */
export function ceremonyFindings(ceremonies, boundaries, truncationMs) {
  const cutByApp = []
  for (const c of ceremonies.filter((x) => x.outcome === 'app-stopped')) {
    const last = c.tracks.at(-1)
    const speaking = last.kind !== 'silence' && (last.stoppedShortMs ?? 0) > truncationMs
    const unreached = c.expectedTracks !== null && c.tracks.length < c.expectedTracks
    if (speaking || unreached) {
      cutByApp.push({
        name: c.name,
        ordinal: c.ordinal,
        label: ceremonyLabel(c),
        unplayedMs: speaking ? Math.round(last.stoppedShortMs) : 0,
        clipsUnreached: unreached ? c.expectedTracks - c.tracks.length : 0,
      })
    }
  }
  const countdowns = ceremonies.filter((c) => c.name === 'countdown')
  const talkedOver = []
  const gaps = []
  for (const countdown of countdowns) {
    // The rest line of the same rest: the last one begun before this countdown.
    const restLine = ceremonies
      .filter((c) => c.name === 'rest-line' && c.playingAtMs < countdown.playingAtMs)
      .at(-1)
    if (
      restLine &&
      restLine.lastSoundMs !== null &&
      countdown.firstSoundMs !== null &&
      restLine.lastSoundMs > countdown.firstSoundMs
    ) {
      talkedOver.push({
        label: ceremonyLabel(countdown),
        overlapMs: Math.round(restLine.lastSoundMs - countdown.firstSoundMs),
      })
    }
    const next = boundaries.find(
      (b) => b.transition === 'work-entered' && b.atMs > countdown.playingAtMs,
    )
    if (
      countdown.outcome === 'complete' &&
      countdown.lastSoundMs !== null &&
      next?.bell?.firstSoundMs != null
    ) {
      gaps.push(next.bell.firstSoundMs - countdown.lastSoundMs)
    }
  }
  const mixedVolumes = []
  for (const c of ceremonies) {
    const volumes = [
      ...new Set(c.tracks.filter((t) => t.kind !== 'silence').map((t) => t.play.volume)),
    ]
    if (volumes.length > 1) mixedVolumes.push({ label: ceremonyLabel(c), volumes })
  }
  return {
    found: ceremonies.reduce((tally, c) => ({ ...tally, [c.name]: (tally[c.name] ?? 0) + 1 }), {}),
    broken: ceremonies
      .filter((c) => c.outcome === 'broken')
      .map((c) => ({ name: c.name, ordinal: c.ordinal, label: ceremonyLabel(c), why: c.why })),
    cutByApp,
    talkedOver,
    mixedVolumes,
    countdownToBellMs: gaps,
  }
}
