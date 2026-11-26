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
import { scoredRounds, type GeneratedWorkout } from '../GeneratedWorkout'
import { expandTimeline } from '../../programs/CueTimeline'
import { punchTokens } from '../WorkoutTokens'
import { CADENCE_PROFILES } from '../cadence'
import { comboSpecFor, roundSpanMs } from '../roundFill'
import { layBlocks, type BlockSpec } from '../samples/authoring'
import type { ProgramRound } from '../WorkoutTokens'
import { CEREMONIES, contractViolations, grid, sweepViolations } from './helpers/generatorContract'

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

      const timelineRound = timeline.find(
        (t) =>
          t.workDurationMs === round.workDurationMs &&
          t.roundIndex === workout.schedule.indexOf(round),
      )
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
// The generator contract, wherever the recipe goes (generator 1.3.1)
//
// The suite above samples ONE goal — the default, at twenty minutes — which
// is why three different ways of stopping a round early passed it for as
// long as they did:
//
// - a low punch goal: a repeat phase kept its few reps even when its gap had
//   clamped at the ceiling, so a twenty-minute goal kept for sixty minutes
//   ran every round out 41-61 s early. 775 of 1,152 sampled cells failed.
// - sprint tempo: the repair pass was bounded by a COUNT of passes, each
//   worth under a second, and ran out 5-7 s early on 6 of 144 sprint cells.
// - low variety: the "settle in" announcement was paid for by dropping whole
//   trailing blocks, 15-25 s at a time — and no sweep ran that pass at all,
//   because every one generated without options.
//
// So the contract lives in one helper and every grid here runs it under
// both option sets. See `helpers/generatorContract.ts`.
// ---------------------------------------------------------------------------

const DURATIONS = [20, 30, 40, 60] as const
const GOALS = [50, 100, 150, 200, 300, 450, 600, 900, 1_200, 2_000, 3_000, 6_000]
const GOAL_SEEDS = ['a', 'b', 'c']
const ALL_CADENCES = Object.keys(CADENCE_PROFILES) as Array<WorkoutRecipe['cadenceProfile']>

describe.each(DURATIONS)('the contract at any goal — %i minutes', (durationMinutes) => {
  it.each(GOALS)('holds at a goal of %i, at every cadence and option set', (totalPunchGoal) => {
    expect(
      sweepViolations(
        grid({
          durationMinutes: [durationMinutes],
          totalPunchGoal: [totalPunchGoal],
          cadenceProfile: ALL_CADENCES,
          seed: GOAL_SEEDS,
        }),
      ),
    ).toEqual([])
  })
})

const LOW_VARIETY: Array<[string, Partial<WorkoutRecipe>]> = [
  ['combinations capped at 2', { maximumComboPunches: 2 }],
  ['combinations capped at 3', { maximumComboPunches: 3 }],
  ['jab only', { enabledPunches: [1] }],
  ['jab and cross, capped at 2', { enabledPunches: [1, 2], maximumComboPunches: 2 }],
  ['jab, cross and hook', { enabledPunches: [1, 2, 3] }],
]

describe.each(LOW_VARIETY)('the contract with little to work with — %s', (_label, over) => {
  it('holds at every cadence and option set', () => {
    const cells = grid({
      cadenceProfile: ALL_CADENCES,
      durationMinutes: [20, 40] as const,
      seed: ['a', 'b', 'x'],
    })
    expect(sweepViolations(cells.map((cell) => ({ ...over, ...cell })))).toEqual([])
  })
})

describe('after paying for an announcement the round is topped back up', () => {
  // Trimming lands within one rep of the bell, and at technical tempo a rep
  // is several seconds. The repair pass promises to work to within 2 s of
  // the bell (`REPAIR_BELL_MARGIN_MS`); the announcement pass has to keep
  // that promise after taking time back. Across a 27,648-round search,
  // skipping the top-up left 134 rounds more than 2 s short (worst 4.2 s)
  // against 11 with it (worst 2.2 s, where one more rep will not fit). The
  // grid below is the corner of that search where it shows.
  it('ends every technical-tempo round within a breath of the bell', () => {
    let worst = { at: '', tailMs: 0 }
    for (const totalPunchGoal of [300, 900, 2_000]) {
      for (const seed of ['a', 'b', 'x', 'q', 'k1', 'k2', 'k3', 'k4']) {
        const workout = generateWorkout(
          {
            ...defaultRecipe(),
            seed,
            totalPunchGoal,
            durationMinutes: 40,
            cadenceProfile: 'technical',
            maximumComboPunches: 2,
          },
          CEREMONIES,
        )
        for (const round of scoredRounds(workout.schedule)) {
          const tailMs = Math.round(round.workDurationMs - roundSpanMs(round.blocks))
          if (tailMs > worst.tailMs) worst = { at: `${totalPunchGoal}/${seed}/${round.id}`, tailMs }
        }
      }
    }
    expect(worst.tailMs).toBeLessThanOrEqual(2_500)
  })
})

describe('the contract helper reports what it is meant to', () => {
  // A sweep that returns [] proves something only if the helper would have
  // said otherwise. Three hand-laid rounds, one per rule.
  const BPM = 100
  const roundOf = (workDurationMs: number, specs: BlockSpec[]): ProgramRound => ({
    id: 'r1',
    order: 1,
    kind: 'round',
    countsTowardGoal: true,
    theme: 'Hand-laid',
    workDurationMs,
    restAfterMs: 0,
    targetPunches: 0,
    blocks: layBlocks(specs, BPM),
  })
  const workoutOf = (round: ProgramRound): GeneratedWorkout => ({
    id: 'hand-laid',
    recipe: defaultRecipe(),
    schedule: [round],
    roundPunchTargets: [0],
    expectedTechniqueDistribution: {},
    estimatedActivePunchesPerMinute: 60,
    warnings: [],
  })
  const spanOf = (specs: BlockSpec[]): number => roundSpanMs(layBlocks(specs, BPM))

  it('says nothing about a round that is full, valid and announced', () => {
    const specs = [comboSpecFor('a', '1-2', 10, 1), comboSpecFor('b', '1-2-3', 10, 1)]
    const workout = workoutOf(roundOf(spanOf(specs) + 1_000, specs))
    expect(contractViolations(workout, CEREMONIES)).toEqual([])
  })

  it('reports a round that stops before its bell', () => {
    const specs = [comboSpecFor('a', '1-2', 10, 1)]
    const workout = workoutOf(roundOf(spanOf(specs) + 20_000, specs))
    expect(contractViolations(workout)).toEqual([
      expect.stringMatching(/^covered: r1 stops 20000 ms before its bell$/),
    ])
  })

  it('reports a block that runs past the bell', () => {
    const specs = [comboSpecFor('a', '1-2', 10, 1)]
    const workout = workoutOf(roundOf(spanOf(specs) - 3_000, specs))
    expect(contractViolations(workout)).toEqual([
      expect.stringMatching(/^valid: block-overruns-round/),
    ])
  })

  it('reports a long same-move stretch with no announcement, only when ceremonies are on', () => {
    // Two blocks of one combination, back to back, over a minute between them.
    const specs = [comboSpecFor('a', '1-2', 40, 1), comboSpecFor('b', '1-2', 40, 1)]
    expect(spanOf(specs)).toBeGreaterThan(60_000)
    const workout = workoutOf(roundOf(spanOf(specs) + 1_000, specs))

    expect(contractViolations(workout, CEREMONIES)).toEqual([
      expect.stringMatching(/^announced: r1\/a is \d+ s of 1-2 with no announcement$/),
    ])
    // Without ceremonies the announcement pass does not run, so there is no
    // rule to break.
    expect(contractViolations(workout)).toEqual([])
  })
})
