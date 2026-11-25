/**
 * The generator options a recipe runs with on this device.
 *
 * `generateWorkout` is pure and knows nothing about which clips exist; the
 * app layer tells it, through `FillOptions`. That makes the options part of
 * the workout's identity: the same recipe generated with different options
 * is a different workout (a ladder with no rendered clip is dropped, a
 * ceremony's reservation shifts every block after it).
 *
 * So there is one builder, and everything that generates from a recipe uses
 * it — the live screen, which runs the workout, and the recipe screen, which
 * warns about it. Two copies would let the recipe screen describe a workout
 * the live screen never runs.
 */
import { findComboAnnounce } from '@audio/voiceAssets/comboAnnounceManifest'
import { CALLOUT_CLIPS } from '@audio/voiceAssets/calloutManifest'
import type { FillOptions } from '@domain/workout/roundFill'
import type { WorkoutRecipe } from '@domain/workout/WorkoutRecipe'

export function fillOptionsForRecipe(recipe: WorkoutRecipe): FillOptions {
  const vocabulary = recipe.voiceVocabulary === 'names' ? 'techniques' : 'numbers'
  const clips = CALLOUT_CLIPS as Record<string, { durationMs: number }>

  return {
    // The clip gate (M1/M3): the generator's build-up ladders only emit
    // notations the coach can actually say. A notation with no rendered clip
    // drops that ladder from selection rather than sending the coach to the
    // per-word fallback for a whole round.
    //
    // M39-V2 Phase 5-iv: the per-punch phrase corpus retired; the gate reads
    // from the combo-announce library, the V2 source of truth for "coach can
    // speak this combination."
    voiceReady: (notation) => findComboAnnounce(notation, vocabulary) !== undefined,
    // Set Ceremonies: price a pre-set call-out from MEASURED clip lengths so
    // the fill can reserve exactly the lead-in the coach needs. Any missing
    // clip prices to undefined — the ceremony is skipped, never guessed.
    ...(recipe.voiceMode === 'off'
      ? {}
      : {
          setupCallouts: {
            reserveMsFor: (asset: string, notation?: string, tail?: string) => {
              const sentence = clips[asset]?.durationMs
              if (sentence === undefined) return undefined
              let total = sentence
              if (notation !== undefined) {
                // Phase 5-iv: the announce clip's measured length, not the
                // retired per-punch phrase clip.
                const recite = findComboAnnounce(notation, vocabulary)?.durationMs
                if (recite === undefined) return undefined
                total += recite + 250
              }
              if (tail !== undefined) {
                const tailMs = clips[tail]?.durationMs
                if (tailMs === undefined) return undefined
                total += tailMs + 250
              }
              // Finish-quiet margin plus start slack.
              return total + 800
            },
          },
        }),
  }
}
