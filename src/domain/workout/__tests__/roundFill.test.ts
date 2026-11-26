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
import { MANDATORY_SAME_MOVE_MS } from '../setupCallouts'
import { roundSpanMs } from '../roundFill'

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

// ---------------------------------------------------------------------------
// D26 with set ceremonies priced in (generator 1.3.1)
//
// Every sweep above generates WITHOUT `setupCallouts`, so none of them runs
// the pass that announces a long same-move stretch — the app always does.
// That pass adds a 6-7 s "settle in" reservation after the round has been
// filled to the bell, and used to pay for it by dropping whole trailing
// blocks with nothing refilling the round: on one measured round a 6.6 s
// reservation cost a 2.1 s block and then a 25.7 s one, and the round ended
// 15 s early. It needs a long run of one combination, so it showed up where
// variety is low — a combination cap of 2 is enough, with every punch enabled.
// ---------------------------------------------------------------------------

/** Every ceremony priced at a typical measured length. */
const CEREMONIES = { setupCallouts: { reserveMsFor: () => 6_500 } }
const LOW_VARIETY: Array<[string, Partial<WorkoutRecipe>]> = [
  ['the default recipe', {}],
  ['combinations capped at 2', { maximumComboPunches: 2 }],
  ['jab only', { enabledPunches: [1] }],
  ['jab and cross, capped at 2', { enabledPunches: [1, 2], maximumComboPunches: 2 }],
]
const CEREMONY_SEEDS = ['a', 'b', 'x']

const notationOf = (block: { tokens: ReadonlyArray<{ kind: string }> }): string =>
  block.tokens
    .map((t) => {
      const token = t as { kind: string; number?: number; body?: boolean }
      return token.kind === 'punch' ? `${token.number}${token.body ? 'b' : ''}` : token.kind
    })
    .join('-')

describe.each(LOW_VARIETY)('with ceremonies priced in — %s', (_label, over) => {
  const workouts = (): Array<ReturnType<typeof generateWorkout>> =>
    ALL_CADENCES.flatMap((cadenceProfile) =>
      ([20, 40] as const).flatMap((durationMinutes) =>
        CEREMONY_SEEDS.map((seed) =>
          generateWorkout(
            { ...defaultRecipe(), ...over, seed, durationMinutes, cadenceProfile },
            CEREMONIES,
          ),
        ),
      ),
    )

  it('covers every scored round to the bell', () => {
    for (const workout of workouts()) {
      for (const round of scoredRounds(workout.schedule)) {
        const coverage = coverageAudit(round.blocks, round.workDurationMs)
        const at = `${workout.recipe.cadenceProfile}/${workout.recipe.durationMinutes}/${workout.recipe.seed}/${round.id}`
        expect({
          at,
          shortByMs: coverage.ok ? 0 : Math.round(round.workDurationMs - coverage.spanMs),
        }).toEqual({ at, shortByMs: 0 })
      }
    }
  })

  it('never runs a round past its bell', () => {
    for (const workout of workouts()) {
      expect(validateGeneratedWorkout(workout).map((e) => e.code)).toEqual([])
    }
  })

  it('announces every same-move stretch longer than a minute', () => {
    for (const workout of workouts()) {
      for (const round of scoredRounds(workout.schedule)) {
        const blocks = round.blocks
        let start = 0
        while (start < blocks.length) {
          const first = blocks[start]!
          let end = start + 1
          while (
            end < blocks.length &&
            first.kind === 'repeated-combo' &&
            blocks[end]!.kind === 'repeated-combo' &&
            notationOf(blocks[end]!) === notationOf(first)
          ) {
            end += 1
          }
          const last = blocks[end - 1]!
          const runMs = last.startOffsetMs + last.durationMs - first.startOffsetMs
          if (runMs > MANDATORY_SAME_MOVE_MS) {
            const at = `${workout.recipe.cadenceProfile}/${workout.recipe.seed}/${round.id}/${first.id}`
            expect({ at, announced: first.setupCallout !== undefined }).toEqual({
              at,
              announced: true,
            })
          }
          start = end
        }
      }
    }
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
