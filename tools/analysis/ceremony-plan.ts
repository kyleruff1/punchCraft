/**
 * What the coach should say around the rounds: the walkout before round 1,
 * and in each rest the line that opens it and the countdown that closes it.
 *
 * The manifest held the rounds and nothing between them. These three are
 * native playlists the app builds and logs as it builds them — how many
 * tracks, how long, which script — so each has a line to be held to.
 *
 * ## Where each expectation comes from
 *
 * - **The walkout** is the app's own planner, `planIntro`, and the way
 *   `IntroPlayer.load` lays a plan out as tracks.
 * - **The rest line** is the script authored for that rest
 *   (`rest/<workout>/r<n>`), which the live screen plays in place of the
 *   generic recovery walkthrough whenever one exists. All 41 rests in the 22
 *   sample workouts have one. A rest without one gets the walkthrough, picked
 *   from the workout's seed — that has no expectation here (`null`).
 * - **The countdown** opens with one of fifteen lines picked at random, so
 *   its length cannot be named. Its length LESS the opener can: the theme,
 *   the next round's opening lead-in, "round N", and the breaths between.
 *   The app logs which opener it picked, and the verifier subtracts it.
 *
 * ## This restates two of the app's rules
 *
 * How a countdown is assembled lives in `RoundWarningPlayer.prepare`, and how
 * a walkout becomes tracks in `IntroPlayer.load`. Both build a native
 * playlist, so neither can be called from here; their arithmetic is restated
 * below. A copy drifts — that is how the manifest came to under-count calls
 * (N-20) — so `__tests__/ceremony-plan.test.ts` runs the real players and
 * holds this file to what they log, for every workout and every opener.
 */
import { planIntro } from '../../src/audio/introPlan'
import { findClickScript } from '../../src/audio/voiceAssets/clickScriptManifest'
import { themeClipFor } from '../../src/audio/voiceAssets/calloutManifest'
import { INTRO_SEGMENTS } from '../../src/audio/voiceAssets/introManifest'
import { silenceFor } from '../../src/audio/voiceAssets/silenceManifest'
import type { GeneratedWorkout } from '../../src/domain/workout/GeneratedWorkout'

type Vocabulary = 'numbers' | 'techniques'

/** `RoundWarningPlayer`'s `OPENER_COUNT`. */
export const COUNTDOWN_OPENER_COUNT = 15
/** `RoundWarningPlayer`'s `OPENER_GAP_MS`: the breath between a countdown's clips. */
export const COUNTDOWN_GAP_MS = 350

export interface ExpectedWalkout {
  /** The clips, in order. */
  segments: readonly string[]
  /** Clips and the silences between them — what `intro loaded` logs as `plannedMs`. */
  plannedMs: number
  /** Native tracks: every clip and every silence. */
  tracks: number
}

export interface ExpectedRestLine {
  /** The script's clip id — what `recovery loaded` logs as `scriptId`. */
  scriptId: string
  slot: string
  text: string
  plannedMs: number
  tracks: number
}

export interface ExpectedCountdown {
  /** The round it counts into, 1-based — what `round warning prepared` logs as `round`. */
  round: number
  /** What follows the opener, in order: a theme, a lead-in, `warn-round-N`. */
  afterOpener: readonly string[]
  /** `totalMs` less the opener's own length: the clips after it and every breath. */
  afterOpenerMs: number
  /** Native tracks, the opener and the silences included. */
  tracks: number
}

/** What the rest after a round should hold. */
export interface ExpectedRest {
  /** `null`: no script was authored for this rest, and the walkthrough is not checked. */
  restLine: ExpectedRestLine | null
  /** `null`: no "round N" clip was rendered for the next round, and the app plays nothing. */
  countdown: ExpectedCountdown | null
}

/**
 * The walkout, as `IntroPlayer.load` builds it from the app's plan: a silence
 * track before every segment that has a gap, then the segment.
 */
export function expectedWalkout(
  workout: GeneratedWorkout,
  vocabulary: Vocabulary,
): ExpectedWalkout | null {
  const plan = planIntro(workout, INTRO_SEGMENTS, vocabulary)
  if (plan.segments.length === 0) return null
  let plannedMs = 0
  let tracks = 0
  for (const segment of plan.segments) {
    if (silenceFor(segment.gapBeforeMs) !== undefined) {
      plannedMs += segment.gapBeforeMs
      tracks += 1
    }
    plannedMs += segment.durationMs
    tracks += 1
  }
  return { segments: plan.segments.map((s) => s.id), plannedMs, tracks }
}

/** The fifteen lines a countdown may open with, and how long each is. */
export function countdownOpeners(): Record<string, number> {
  const openers: Record<string, number> = {}
  for (let i = 1; i <= COUNTDOWN_OPENER_COUNT; i += 1) {
    const id = `warn-opener-${String(i).padStart(2, '0')}`
    const clip = INTRO_SEGMENTS[id]
    if (clip) openers[id] = clip.durationMs
  }
  return openers
}

/**
 * What the rest after round `roundIndex` (0-based) should hold, or `null`
 * when no round follows it.
 */
export function expectedRest(
  workout: GeneratedWorkout,
  roundIndex: number,
  vocabulary: Vocabulary,
): ExpectedRest | null {
  const next = workout.schedule[roundIndex + 1]
  if (!next) return null

  const slot = `rest/${workout.id}/r${roundIndex + 1}`
  const script = findClickScript(slot, vocabulary)
  // One segment and no pause after it: one track, and its length the clip's.
  const restLine: ExpectedRestLine | null = script
    ? { scriptId: script.id, slot, text: script.text, plannedMs: script.durationMs, tracks: 1 }
    : null

  // `RoundWarningPlayer.prepare`: opener, then theme, lead-in and "round N",
  // each after a breath — when the breath's silence track exists.
  const round = roundIndex + 2
  const core = INTRO_SEGMENTS[`warn-round-${round}`]
  let countdown: ExpectedCountdown | null = null
  if (core) {
    const theme = next.theme === undefined ? undefined : themeClipFor(next.theme)
    const lead = findClickScript(`lead-in/${workout.id}/r${round}s1`, vocabulary)
    const after = [
      ...(theme ? [{ id: theme.id, durationMs: theme.durationMs }] : []),
      ...(lead ? [{ id: lead.id, durationMs: lead.durationMs }] : []),
      { id: `warn-round-${round}`, durationMs: core.durationMs },
    ]
    const breath = silenceFor(COUNTDOWN_GAP_MS) !== undefined
    countdown = {
      round,
      afterOpener: after.map((clip) => clip.id),
      afterOpenerMs: after.reduce(
        (sum, clip) => sum + clip.durationMs + (breath ? COUNTDOWN_GAP_MS : 0),
        0,
      ),
      tracks: 1 + after.length * (breath ? 2 : 1),
    }
  }
  return { restLine, countdown }
}
