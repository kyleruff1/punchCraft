/**
 * "Some rounds run out of combinations" — as a recipe conflict.
 *
 * `validateRecipe` judges a recipe on its own. This judges the workout the
 * recipe actually GENERATES, which `validateRecipe` cannot do: generation
 * depends on device-side options (which combinations have a rendered clip,
 * what a ceremony costs), so it lives one step later.
 *
 * A scored round is meant to be covered to the bell (D26). At a low goal per
 * round it is not: the build-up phases come up short and the repair pass
 * cannot make up the difference, so the cue engine reaches the end of its
 * blocks early, the stage swaps to "Free work — keep your hands moving", and
 * the coach says nothing until the bell. The generator has always noticed
 * this (`generateWorkout`'s warnings) and the note went nowhere. This puts
 * it in front of the athlete, before they start, with something to do.
 *
 * Uses `coverageAudit` — the same predicate the generator and its property
 * tests use — so "run dry" here means exactly what it means there.
 *
 * Pure TypeScript — no React, Expo, SQLite or BLE imports (spec §15.1).
 */

import { coverageAudit } from '../programs/mapValidation'
import type { GeneratedWorkout } from './GeneratedWorkout'
import type { RecipeConflict } from './recipeValidation'

export const ROUNDS_RUN_DRY = 'rounds-run-dry'

/** The longest silent tail is quoted to the nearest five seconds. */
const TAIL_ROUNDING_MS = 5_000

export function coverageConflict(workout: GeneratedWorkout): RecipeConflict | null {
  const scored = workout.schedule.filter((round) => round.countsTowardGoal)
  let dry = 0
  let longestTailMs = 0
  for (const round of scored) {
    const audit = coverageAudit(round.blocks, round.workDurationMs)
    if (audit.ok) continue
    dry += 1
    longestTailMs = Math.max(longestTailMs, round.workDurationMs - audit.spanMs)
  }
  if (dry === 0) return null

  const which = dry === scored.length ? 'Every round runs' : `${dry} of ${scored.length} rounds run`
  const seconds = Math.max(
    TAIL_ROUNDING_MS,
    Math.round(longestTailMs / TAIL_ROUNDING_MS) * TAIL_ROUNDING_MS,
  ) / 1_000

  return {
    code: ROUNDS_RUN_DRY,
    fields: ['totalPunchGoal', 'durationMinutes'],
    // The workout still runs, on time, to every bell — so this never blocks.
    severity: 'warning',
    message: `${which} out of combinations before the bell at this goal — the coach goes quiet and the screen shows free work for up to about ${seconds} seconds.`,
    resolution: 'Raise the punch goal, or choose a shorter workout.',
  }
}
