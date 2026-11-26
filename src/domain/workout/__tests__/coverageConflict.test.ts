/**
 * "Rounds run out of combinations" as a recipe conflict.
 *
 * Two kinds of case. The real generator, because the conflict exists to
 * describe what `generateWorkout` actually produces. And hand-laid rounds,
 * because the threshold and the counting are exact claims that a generated
 * workout can only illustrate.
 */
import {
  MATERIAL_TAIL_MS,
  NO_COMBINATIONS,
  ROUNDS_RUN_DRY,
  coverageConflict,
} from '../coverageConflict'
import { canGenerate } from '../recipeValidation'
import { generateWorkout } from '../generateWorkout'
import { defaultRecipe, type WorkoutRecipe } from '../WorkoutRecipe'
import { scoredRounds, type GeneratedWorkout } from '../GeneratedWorkout'
import type { ProgramRound } from '../WorkoutTokens'

const generated = (over: Partial<WorkoutRecipe> = {}): GeneratedWorkout =>
  generateWorkout({ ...defaultRecipe(), seed: 'coverage-conflict', ...over })

const WORK_MS = 240_000

/** A scored round whose blocks stop `tailMs` before the bell. */
function round(order: number, tailMs: number, countsTowardGoal = true): ProgramRound {
  return {
    id: `r${order}`,
    order,
    kind: 'round',
    countsTowardGoal,
    theme: `Round ${order}`,
    workDurationMs: WORK_MS,
    restAfterMs: 60_000,
    targetPunches: 100,
    blocks: [
      {
        id: `r${order}-b1`,
        kind: 'repeated-combo',
        stance: 'inherit',
        startOffsetMs: 0,
        durationMs: WORK_MS - tailMs,
        gapBeats: 1,
        repeat: 1,
        tokens: [{ kind: 'punch', number: 1, body: false, beatOffset: 0 }],
      },
    ],
  }
}

const laid = (...rounds: ProgramRound[]): GeneratedWorkout => ({
  id: 'laid',
  recipe: defaultRecipe(),
  schedule: rounds,
  roundPunchTargets: rounds.map(() => 100),
  expectedTechniqueDistribution: {},
  estimatedActivePunchesPerMinute: 60,
  warnings: [],
})

describe('against the real generator', () => {
  it('says nothing about the default recipe', () => {
    expect(coverageConflict(generated())).toBeNull()
  })

  it('says nothing about a low goal — the fill covers the round regardless', () => {
    // The case that started this: a twenty-minute goal kept for sixty
    // minutes. Until generator 1.3.0 every one of its twelve rounds ran out
    // 41-61 s early. A low goal is no longer a reason for a round to end.
    expect(coverageConflict(generated({ durationMinutes: 60, totalPunchGoal: 900 }))).toBeNull()
    expect(coverageConflict(generated({ durationMinutes: 20, totalPunchGoal: 50 }))).toBeNull()
  })

  it('says nothing about a single punch at a fast cadence', () => {
    // Was the flagged case through generator 1.3.0: jab-only at sprint tempo
    // ran the count-bounded repair pass out before the bell. Bounded by
    // progress (1.3.1), it fills.
    expect(
      coverageConflict(generated({ enabledPunches: [1], cadenceProfile: 'sprint' })),
    ).toBeNull()
  })

  it.each([
    ['the cross on its own', [2]],
    ['the two uppercuts', [5, 6]],
    ['the two hooks', [3, 4]],
  ] as const)('refuses a workout whose punches form no combination — %s', (_name, punches) => {
    // In no motif the library has, so there is no ladder to teach and no
    // fallback to repeat: every round is laid empty. The recipe screen calls
    // the missing jab a warning ("variety will be reduced"); this is what it
    // actually costs, and it is an error because there is nothing to run.
    const workout = generated({ enabledPunches: [...punches] })
    expect(scoredRounds(workout.schedule).every((r) => r.blocks.length === 0)).toBe(true)

    const conflict = coverageConflict(workout)
    expect(conflict).toMatchObject({
      code: NO_COMBINATIONS,
      severity: 'error',
      fields: ['enabledPunches', 'maximumComboPunches'],
      message: 'These punches do not form any combination, so every round would be empty.',
    })
    expect(conflict?.resolution).toMatch(/jab/i)
    expect(canGenerate(conflict ? [conflict] : [])).toBe(false)
  })

  it.each([
    ['jab and cross, capped at two', { enabledPunches: [1, 2], maximumComboPunches: 2 }],
    ['the jab alone, capped at one', { enabledPunches: [1], maximumComboPunches: 1 }],
    ['cross and lead hook, capped at two', { enabledPunches: [2, 3], maximumComboPunches: 2 }],
  ] as const)('does not refuse a narrow recipe that still has content — %s', (_name, over) => {
    const conflict = coverageConflict(
      generated({ ...over, enabledPunches: [...over.enabledPunches] }),
    )
    expect(conflict?.severity).not.toBe('error')
  })
})

describe('what counts', () => {
  it('ignores a round that stops within the material threshold of its bell', () => {
    const workout = laid(round(1, 0), round(2, 4_000), round(3, MATERIAL_TAIL_MS))
    expect(coverageConflict(workout)).toBeNull()
  })

  it('flags a round that stops further short than that', () => {
    const conflict = coverageConflict(laid(round(1, 0), round(2, MATERIAL_TAIL_MS + 1)))
    expect(conflict?.message).toContain('1 of 2 rounds run out')
  })

  it('counts only the rounds that are short', () => {
    const conflict = coverageConflict(
      laid(round(1, 30_000), round(2, 0), round(3, 45_000), round(4, 2_000)),
    )
    expect(conflict?.message).toContain('2 of 4 rounds run out')
  })

  it('says "every round" when it is every round', () => {
    const conflict = coverageConflict(laid(round(1, 30_000), round(2, 45_000)))
    expect(conflict?.message).toContain('Every round runs out')
  })

  it('quotes the longest silent stretch, to the nearest five seconds', () => {
    const conflict = coverageConflict(laid(round(1, 22_000), round(2, 47_000)))
    expect(conflict?.message).toContain('up to about 45 seconds')
  })

  it('ignores warm-up and cooldown, which carry no content contract', () => {
    expect(coverageConflict(laid(round(1, 0), round(2, 120_000, false)))).toBeNull()
  })

  it('is an error only when EVERY scored round is empty', () => {
    const empty = (order: number, counts = true): ProgramRound => ({
      ...round(order, 0, counts),
      blocks: [],
    })
    expect(coverageConflict(laid(empty(1), empty(2)))?.code).toBe(NO_COMBINATIONS)
    // One round with content: the workout runs, so it is the warning.
    const mixed = coverageConflict(laid(empty(1), round(2, 0)))
    expect(mixed).toMatchObject({ code: ROUNDS_RUN_DRY, severity: 'warning' })
    expect(mixed?.message).toContain('1 of 2 rounds run out')
    // An empty warm-up beside full rounds is nothing at all.
    expect(coverageConflict(laid(empty(1, false), round(2, 0)))).toBeNull()
    // And a schedule with no scored round is not this module's business.
    expect(coverageConflict(laid(empty(1, false)))).toBeNull()
  })
})

describe('what it tells the athlete', () => {
  const conflict = coverageConflict(laid(round(1, 30_000)))

  it('is a warning while any round has content — the workout still runs to every bell', () => {
    expect(conflict?.severity).toBe('warning')
  })

  it('points at the controls that can fix it, and says how', () => {
    // Not the punch goal: since 1.3.0 a round fills at any goal, so "raise
    // the goal" would be advice that changes nothing.
    expect(conflict?.fields).toEqual(['enabledPunches', 'maximumComboPunches'])
    expect(conflict?.resolution).toMatch(/more punches/i)
    expect(conflict?.resolution).toMatch(/longer combinations/i)
  })
})
