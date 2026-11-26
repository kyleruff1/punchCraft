/**
 * The generator's contract, as one function every sweep runs.
 *
 * Until generator 1.3.1 each property sweep generated its workouts with
 * `generateWorkout(recipe)` and no options. The app never does that: it
 * passes `fillOptionsForRecipe(recipe)`, and one of those options —
 * `setupCallouts` — is what switches on the pass that announces a long
 * same-move stretch. So that pass was run by no test at all, and it was the
 * one dropping 15-25 s off the end of low-variety rounds.
 *
 * The fix for that class of gap is not another sweep. It is that a sweep
 * cannot be written without choosing its option sets, and that the default
 * choice — `OPTION_SETS` — includes the app's shape. A new fill pass gated
 * on an option is then covered by every existing grid the day it lands.
 *
 * Not a test file: jest ignores `__tests__/helpers/`.
 */
import { coverageAudit } from '../../../programs/mapValidation'
import {
  scoredRounds,
  validateGeneratedWorkout,
  type GeneratedWorkout,
} from '../../GeneratedWorkout'
import { generateWorkout } from '../../generateWorkout'
import type { FillOptions } from '../../roundFill'
import { MANDATORY_SAME_MOVE_MS } from '../../setupCallouts'
import { defaultRecipe, type WorkoutRecipe } from '../../WorkoutRecipe'
import type { WorkoutBlock } from '../../WorkoutTokens'

/** Every ceremony priced at a typical measured length. */
export const CEREMONIES: FillOptions = { setupCallouts: { reserveMsFor: () => 6_500 } }

/**
 * The option sets a domain sweep runs under: none at all, and the app's
 * shape. (The app's REAL options, with measured clip lengths, live outside
 * the domain; `src/audio/__tests__/fillOptionsForRecipe.contract.test.ts`
 * runs this same contract with them.)
 */
export const OPTION_SETS: ReadonlyArray<
  readonly [label: string, options: FillOptions | undefined]
> = [
  ['no options', undefined],
  ['ceremonies priced in', CEREMONIES],
]

const notationOf = (block: WorkoutBlock): string =>
  block.tokens
    .map((t) => (t.kind === 'punch' ? `${t.number}${t.body ? 'b' : ''}` : t.kind))
    .join('-')

/**
 * Everything wrong with one generated workout, as readable lines. Empty
 * means the contract holds. Each line starts with the rule it breaks:
 *
 * - `valid:` it validates — in particular no block runs past its bell;
 * - `covered:` every scored round is covered to the bell (D26);
 * - `announced:` when ceremonies are on, every run of one combination
 *   longer than a minute opens with its announcement (Kyle's same-move
 *   rule).
 */
export function contractViolations(workout: GeneratedWorkout, options?: FillOptions): string[] {
  const out: string[] = []
  for (const error of validateGeneratedWorkout(workout))
    out.push(`valid: ${error.code} at ${error.path}`)

  for (const round of scoredRounds(workout.schedule)) {
    const coverage = coverageAudit(round.blocks, round.workDurationMs)
    if (!coverage.ok) {
      out.push(
        `covered: ${round.id} stops ${Math.round(round.workDurationMs - coverage.spanMs)} ms before its bell`,
      )
    }

    if (!options?.setupCallouts) continue
    const blocks = round.blocks
    let start = 0
    while (start < blocks.length) {
      const first = blocks[start] as WorkoutBlock
      let end = start + 1
      while (
        end < blocks.length &&
        first.kind === 'repeated-combo' &&
        (blocks[end] as WorkoutBlock).kind === 'repeated-combo' &&
        notationOf(blocks[end] as WorkoutBlock) === notationOf(first)
      ) {
        end += 1
      }
      const last = blocks[end - 1] as WorkoutBlock
      const runMs = last.startOffsetMs + last.durationMs - first.startOffsetMs
      if (runMs > MANDATORY_SAME_MOVE_MS && first.setupCallout === undefined) {
        out.push(
          `announced: ${round.id}/${first.id} is ${Math.round(runMs / 1000)} s of ${notationOf(first)} with no announcement`,
        )
      }
      start = end
    }
  }
  return out
}

/**
 * Generate every recipe in `grid` under every option set and collect what
 * breaks the contract, each line naming its recipe so a failure can be
 * reproduced. `expect(sweepViolations(grid)).toEqual([])`.
 */
export function sweepViolations(
  grid: ReadonlyArray<Partial<WorkoutRecipe>>,
  optionSets: ReadonlyArray<readonly [string, FillOptions | undefined]> = OPTION_SETS,
  optionsFor?: (recipe: WorkoutRecipe) => FillOptions,
): string[] {
  const out: string[] = []
  for (const over of grid) {
    const recipe: WorkoutRecipe = { ...defaultRecipe(), ...over }
    const runs = optionsFor ? [['app options', optionsFor(recipe)] as const] : optionSets
    for (const [label, options] of runs) {
      const workout = options ? generateWorkout(recipe, options) : generateWorkout(recipe)
      for (const violation of contractViolations(workout, options)) {
        out.push(`${JSON.stringify(over)} [${label}] ${violation}`)
      }
    }
  }
  return out
}

/** The rules `contractViolations` checks; each violation line names one. */
export type ContractRule = 'valid' | 'covered' | 'announced'

/** The violations of one rule — for a sweep that has to set one aside. */
export function ofRule(violations: readonly string[], rule: ContractRule): string[] {
  return violations.filter((line) => line.startsWith(`${rule}: `) || line.includes(`] ${rule}: `))
}

/** The cross product of the given field values, as recipe overrides. */
export function grid<K extends keyof WorkoutRecipe>(axes: {
  [P in K]: ReadonlyArray<WorkoutRecipe[P]>
}): Array<Pick<WorkoutRecipe, K>> {
  let cells: Array<Record<string, unknown>> = [{}]
  for (const key of Object.keys(axes) as K[]) {
    cells = cells.flatMap((cell) => axes[key].map((value) => ({ ...cell, [key]: value })))
  }
  return cells as Array<Pick<WorkoutRecipe, K>>
}
