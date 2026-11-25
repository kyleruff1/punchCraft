/**
 * "Rounds run out of combinations" as a recipe conflict.
 *
 * Two kinds of case. The real generator, because the conflict exists to
 * describe what `generateWorkout` actually produces. And hand-laid rounds,
 * because the threshold and the counting are exact claims that a generated
 * workout can only illustrate.
 */
import { MATERIAL_TAIL_MS, ROUNDS_RUN_DRY, coverageConflict } from '../coverageConflict'
import { generateWorkout } from '../generateWorkout'
import { defaultRecipe, type WorkoutRecipe } from '../WorkoutRecipe'
import type { GeneratedWorkout } from '../GeneratedWorkout'
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

  it('flags a workout built from a single punch at a fast cadence', () => {
    // One enabled punch leaves no build-up ladder to teach and nothing but
    // one motif to repeat; at sprint tempo that runs out well before the bell.
    const conflict = coverageConflict(generated({ enabledPunches: [1], cadenceProfile: 'sprint' }))
    expect(conflict?.code).toBe(ROUNDS_RUN_DRY)
    expect(conflict?.message).toMatch(/out of combinations before the bell/)
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
})

describe('what it tells the athlete', () => {
  const conflict = coverageConflict(laid(round(1, 30_000)))

  it('is a warning, never an error — the workout still runs to every bell', () => {
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
