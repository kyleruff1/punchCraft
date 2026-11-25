/**
 * "Rounds run out of combinations" as a recipe conflict.
 *
 * Driven through the real generator rather than hand-built rounds: the
 * conflict exists to describe what `generateWorkout` actually produces, and
 * a fixture that merely looks under-filled would prove nothing about that.
 */
import { ROUNDS_RUN_DRY, coverageConflict } from '../coverageConflict'
import { generateWorkout } from '../generateWorkout'
import { defaultRecipe } from '../WorkoutRecipe'
import { coverageAudit } from '../../programs/mapValidation'
import type { WorkoutDurationMinutes } from '../roundSchedule'

function workoutFor(durationMinutes: WorkoutDurationMinutes, totalPunchGoal: number) {
  return generateWorkout({
    ...defaultRecipe(),
    durationMinutes,
    totalPunchGoal,
    seed: 'coverage-conflict',
  })
}

describe('coverageConflict', () => {
  it('says nothing about the default recipe', () => {
    expect(coverageConflict(workoutFor(20, 900))).toBeNull()
  })

  it('says nothing once the goal is scaled to the duration', () => {
    expect(coverageConflict(workoutFor(60, 2_700))).toBeNull()
  })

  it('flags a twenty-minute goal kept for sixty minutes', () => {
    // 900 punches over twelve rounds is 75 a round. Every round comes up
    // short, by most of a minute.
    const conflict = coverageConflict(workoutFor(60, 900))
    expect(conflict).not.toBeNull()
    expect(conflict?.code).toBe(ROUNDS_RUN_DRY)
    expect(conflict?.message).toContain('Every round runs out of combinations')
  })

  it('is a warning, never an error — the workout still runs to every bell', () => {
    expect(coverageConflict(workoutFor(60, 900))?.severity).toBe('warning')
  })

  it('points at the two controls that can fix it, and says how', () => {
    const conflict = coverageConflict(workoutFor(60, 900))
    expect(conflict?.fields).toEqual(['totalPunchGoal', 'durationMinutes'])
    expect(conflict?.resolution).toMatch(/punch goal/i)
    expect(conflict?.resolution).toMatch(/shorter/i)
  })

  it('counts exactly the rounds the generator\'s own audit fails', () => {
    for (const [minutes, goal] of [
      [60, 900],
      [40, 900],
      [20, 400],
    ] as const) {
      const workout = workoutFor(minutes, goal)
      const scored = workout.schedule.filter((round) => round.countsTowardGoal)
      const dry = scored.filter((round) => !coverageAudit(round.blocks, round.workDurationMs).ok)
      const conflict = coverageConflict(workout)

      expect(dry.length).toBeGreaterThan(0)
      expect(conflict?.message).toContain(
        dry.length === scored.length
          ? 'Every round runs'
          : `${dry.length} of ${scored.length} rounds run`,
      )
    }
  })

  it('quotes the longest silent stretch in whole seconds, to the nearest five', () => {
    const workout = workoutFor(60, 900)
    const longestMs = Math.max(
      ...workout.schedule
        .filter((round) => round.countsTowardGoal)
        .map((round) => round.workDurationMs - coverageAudit(round.blocks, round.workDurationMs).spanMs),
    )
    const quoted = Number(/about (\d+) seconds/.exec(coverageConflict(workout)?.message ?? '')?.[1])
    expect(quoted % 5).toBe(0)
    expect(Math.abs(quoted * 1_000 - longestMs)).toBeLessThanOrEqual(2_500)
  })

  it('ignores warm-up and cooldown, which carry no content contract', () => {
    const workout = workoutFor(20, 900)
    const unscored = workout.schedule.filter((round) => !round.countsTowardGoal)
    expect(unscored.length).toBeGreaterThan(0)
    expect(coverageConflict(workout)).toBeNull()
  })
})
