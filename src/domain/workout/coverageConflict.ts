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
 * One thing, as of generator 1.3.1: **punches that form no combination at
 * all.** A single enabled punch other than the jab, or a pair like the two
 * uppercuts, appears in no motif the library has, so there is no ladder to
 * teach and no fallback to repeat — every round is laid empty. Likewise two
 * punches with combinations capped at one. Hence the advice below.
 *
 * Three other causes have come and gone, and each was first mistaken for
 * the one after it:
 *
 * - a low punch goal: a repeat phase kept too few reps to span its time
 *   share (fixed in 1.3.0);
 * - sprint tempo: the repair pass was bounded by a count of passes and ran
 *   out 5-7 s early (fixed in 1.3.1);
 * - low variety: a long same-move stretch earns a "settle in" call, and
 *   paying for it dropped a whole trailing block with nothing refilling the
 *   round — 15-25 s, with a combination cap of 2 or a jab-only recipe (fixed
 *   in 1.3.1). This one was filed for a while as "a content pool too narrow
 *   for the round", which it never was: the pool could fill the round, and
 *   had, before the announcement took the time back.
 *
 * ## The threshold
 *
 * The generator's own audit allows a round to stop 5 s short — the bell
 * covers it. An athlete-facing warning needs more than a breath: this fires
 * at twice that.
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
