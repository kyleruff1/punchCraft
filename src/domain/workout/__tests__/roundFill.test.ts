/**
 * D26 property suite: no seeded workout may produce a silent round.
 *
 * Coverage-to-the-bell and the silence ceiling are the two guarantees the
 * 2026-08-25 live instruments earned; they hold here for every seed, tier
 * and cadence sampled, so a regression fails CI rather than a bag session.
 */
import { compileRoundRhythmMap } from '../../programs/RhythmMap'
import { coverageAudit, silenceAudit } from '../../programs/mapValidation'
import { generateWorkout } from '../generateWorkout'
import { defaultRecipe, type WorkoutRecipe } from '../WorkoutRecipe'
import { scoredRounds, validateGeneratedWorkout } from '../GeneratedWorkout'
import { expandTimeline } from '../../programs/CueTimeline'
import { punchTokens } from '../WorkoutTokens'
import { CADENCE_PROFILES } from '../cadence'

const durationFor = (combination: string): number | undefined =>
  combination.includes('-') ? 1200 : undefined

const SEEDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']
const TIERS = ['beginner', 'intermediate', 'advanced'] as const

function make(over: Partial<WorkoutRecipe>): ReturnType<typeof generateWorkout> {
  return generateWorkout({ ...defaultRecipe(), ...over })
}

describe.each(SEEDS)('D26 fill properties (seed %s)', (seed) => {
  it.each(TIERS)('%s: every scored round is covered and never silent', (tier) => {
    const workout = make({ seed, tier, durationMinutes: 20 })
    const bpm = CADENCE_PROFILES[workout.recipe.cadenceProfile].nominalBpm
    const timeline = expandTimeline(workout, 'orthodox', bpm)

    for (const round of scoredRounds(workout.schedule)) {
      const coverage = coverageAudit(round.blocks, round.workDurationMs)
      expect(coverage.ok).toBe(true)

      const timelineRound = timeline.find((t) => t.workDurationMs === round.workDurationMs && t.roundIndex === workout.schedule.indexOf(round))
      if (!timelineRound) continue
      const map = compileRoundRhythmMap(timelineRound, {
        cadence: workout.recipe.cadenceProfile,
        durationFor,
      })
      const silence = silenceAudit(map)
      expect(silence.maxGapMs).toBeLessThanOrEqual(20_000)
    }
  })

  it('is deterministic per seed', () => {
    const a = make({ seed, durationMinutes: 20 })
    const b = make({ seed, durationMinutes: 20 })
    expect(a).toEqual(b)
  })

  it('beginner rounds never exceed the tier length band', () => {
    const workout = make({ seed, tier: 'beginner', durationMinutes: 20, maximumComboPunches: 4 })
    for (const round of scoredRounds(workout.schedule)) {
      for (const block of round.blocks) {
        expect(punchTokens(block.tokens).length).toBeLessThanOrEqual(4)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// D26 at any punch goal (generator 1.3.0)
//
// The suite above samples ONE goal — the default, at twenty minutes — which
// is why a fill that under-ran at low goals passed it for as long as it did.
// A repeat phase whose punch share asked for few reps kept those few even
// when its gap had clamped at the ceiling, so the phase spanned a fraction of
// its time share; a twenty-minute goal kept for sixty minutes ran every round
// out 41-61 s before its bell. Before the fix 775 of the 1,152 cells sampled
// below (with a fourth cadence and a second option set) failed this audit.
// ---------------------------------------------------------------------------

const DURATIONS = [20, 30, 40, 60] as const
const GOALS = [50, 100, 150, 200, 300, 450, 600, 900, 1_200, 2_000, 3_000, 6_000]
const GOAL_SEEDS = ['a', 'b', 'c']
const ALL_CADENCES = Object.keys(CADENCE_PROFILES) as Array<WorkoutRecipe['cadenceProfile']>

describe.each(DURATIONS)('D26 at any goal — %i minutes', (durationMinutes) => {
  it.each(GOALS)('covers every scored round to the bell at a goal of %i', (totalPunchGoal) => {
    // Every cadence, sprint included. Sprint was left out of this sweep
    // through generator 1.3.0 and pinned separately as a known residual: the
    // repair pass was bounded by a COUNT of passes (24 two-rep, then 6
    // single), and at sprint tempo a pass adds well under a second, so around
    // 250 punches a round the count ran out 5-7 s before the bell on 6 of the
    // 144 sprint cells. Lifting either count closed all six; the pass is
    // bounded by progress toward the bell now (1.3.1).
    for (const cadenceProfile of ALL_CADENCES) {
      for (const seed of GOAL_SEEDS) {
        const workout = make({ seed, durationMinutes, totalPunchGoal, cadenceProfile })
        for (const round of scoredRounds(workout.schedule)) {
          const coverage = coverageAudit(round.blocks, round.workDurationMs)
          // Named in the failure, so a regression says which round and by how much.
          expect({
            cadenceProfile,
            seed,
            round: round.id,
            shortByMs: coverage.ok ? 0 : round.workDurationMs - coverage.spanMs,
          }).toEqual({ cadenceProfile, seed, round: round.id, shortByMs: 0 })
        }
      }
    }
  })
})

describe('the repair pass never runs a round past its bell', () => {
  // The other half of re-bounding it: a pass that no longer stops at a count
  // must still stop at the bell. `validateGeneratedWorkout` rejects a block
  // that overruns its round, so a sweep with no errors is the proof.
  it.each(ALL_CADENCES)('%s: every generated workout still validates', (cadenceProfile) => {
    for (const durationMinutes of DURATIONS) {
      for (const totalPunchGoal of GOALS) {
        for (const seed of GOAL_SEEDS) {
          const workout = make({ seed, durationMinutes, totalPunchGoal, cadenceProfile })
          expect({
            durationMinutes,
            totalPunchGoal,
            seed,
            errors: validateGeneratedWorkout(workout).map((e) => e.code),
          }).toEqual({ durationMinutes, totalPunchGoal, seed, errors: [] })
        }
      }
    }
  })
})
