/**
 * "Some rounds run out of combinations" — as a recipe conflict.
 *
 * `validateRecipe` judges a recipe on its own. This judges the workout the
 * recipe actually GENERATES, which `validateRecipe` cannot do: generation
 * depends on device-side options (which combinations have a rendered clip,
 * what a ceremony costs), so it lives one step later.
 *
 * A scored round is meant to be covered to the bell (D26). When it is not,
 * the cue engine reaches the end of its blocks early, the stage swaps to
 * "Free work — keep your hands moving", and the coach says nothing until
 * the bell. The generator has always noticed (`generateWorkout`'s warnings)
 * and the note went nowhere. This puts it in front of the athlete before
 * they start, with something to do about it.
 *
 * ## What still causes it
 *
 * Until generator 1.3.0 the common cause was a low punch goal — a repeat
 * phase kept too few reps to span its time share, and a twenty-minute goal
 * kept for sixty minutes left a minute of silence in every round. That is
 * fixed in the fill. What remains is a content pool too narrow for the round:
 * one enabled punch, or combinations capped at one or two, leaves no build-up
 * ladder to teach and not enough to repeat. Hence the advice below.
 *
 * ## The threshold
 *
 * The generator's own audit allows a round to stop 5 s short — the bell
 * covers it. An athlete-facing warning needs more than a breath: this fires
 * at twice that. (A sprint-cadence round can still finish 5-7 s short, where
 * the count-bounded repair pass runs out; that is below this line on
 * purpose, and there is nothing the athlete could change to fix it.)
 *
 * Pure TypeScript — no React, Expo, SQLite or BLE imports (spec §15.1).
 */

import { coverageAudit } from '../programs/mapValidation'
import type { GeneratedWorkout } from './GeneratedWorkout'
import type { RecipeConflict } from './recipeValidation'

export const ROUNDS_RUN_DRY = 'rounds-run-dry'

/** A round must stop at least this far short of its bell to be worth a warning. */
export const MATERIAL_TAIL_MS = 10_000

/** The longest silent tail is quoted to the nearest five seconds. */
const TAIL_ROUNDING_MS = 5_000

export function coverageConflict(workout: GeneratedWorkout): RecipeConflict | null {
  const scored = workout.schedule.filter((round) => round.countsTowardGoal)
  let dry = 0
  let longestTailMs = 0
  for (const round of scored) {
    const audit = coverageAudit(round.blocks, round.workDurationMs, MATERIAL_TAIL_MS)
    if (audit.ok) continue
    dry += 1
    longestTailMs = Math.max(longestTailMs, round.workDurationMs - audit.spanMs)
  }
  if (dry === 0) return null

  const which = dry === scored.length ? 'Every round runs' : `${dry} of ${scored.length} rounds run`
  const seconds = (Math.round(longestTailMs / TAIL_ROUNDING_MS) * TAIL_ROUNDING_MS) / 1_000

  return {
    code: ROUNDS_RUN_DRY,
    fields: ['enabledPunches', 'maximumComboPunches'],
    // The workout still runs, on time, to every bell — so this never blocks.
    severity: 'warning',
    message: `${which} out of combinations before the bell — the coach goes quiet and the screen shows free work for up to about ${seconds} seconds.`,
    resolution:
      'Enable more punches, or allow longer combinations, so the coach has more to work with.',
  }
}
