/**
 * The generator contract, with the options the app really passes.
 *
 * The domain sweeps price every ceremony at a flat 6.5 s. The app prices
 * each one from the measured length of its actual clip
 * (`fillOptionsForRecipe`), skips the ones whose clip is missing, and gates
 * build-up ladders on which combinations have a rendered announce. Those
 * are different rounds — so the contract is run against them too, here,
 * outside the domain where the clip manifests live.
 *
 * This is the check that was run by hand, twice, while fixing the round
 * that lost its last 15-25 s to a "settle in" call (generator 1.3.1).
 */
import { fillOptionsForRecipe } from '../fillOptionsForRecipe'
import {
  OPTION_SETS,
  grid,
  ofRule,
  sweepViolations,
} from '@domain/workout/__tests__/helpers/generatorContract'
import { CADENCE_PROFILES } from '@domain/workout/cadence'
import { MAX_CALLOUT_RESERVE_MS, SETUP_PATTERNS } from '@domain/workout/setupCallouts'
import { defaultRecipe, type WorkoutRecipe } from '@domain/workout/WorkoutRecipe'
import type { PunchNumber } from '@domain/workout/WorkoutTokens'

const ALL_CADENCES = Object.keys(CADENCE_PROFILES) as Array<WorkoutRecipe['cadenceProfile']>

/** Punch sets from which the library can build at least one combination. */
const PUNCH_SETS: PunchNumber[][] = [[1], [1, 2], [1, 2, 3], [1, 2, 3, 4, 5, 6]]
const CAPS = [2, 3, 6]

const violationsFor = (enabledPunches: PunchNumber[], maximumComboPunches: number): string[] =>
  sweepViolations(
    grid({
      cadenceProfile: ALL_CADENCES,
      durationMinutes: [20, 40] as const,
      seed: ['a', 'x'],
    }).map((cell) => ({ ...cell, enabledPunches, maximumComboPunches })),
    OPTION_SETS,
    fillOptionsForRecipe,
  )

describe.each(PUNCH_SETS)('with the app’s own fill options — punches %p', (...enabledPunches) => {
  it.each(CAPS)('fills every round and overruns none, combinations capped at %i', (cap) => {
    const violations = violationsFor(enabledPunches, cap)
    expect(ofRule(violations, 'covered')).toEqual([])
    expect(ofRule(violations, 'valid')).toEqual([])
  })
})

describe('a long same-move stretch is always announced (N-6)', () => {
  // A run of one combination longer than a minute must open with a "coast"
  // call (Kyle's rule). `pickCallout` draws one of the pattern's variants and
  // prices it — sentence, recitation of the combination, tail — and a total
  // over `MAX_CALLOUT_RESERVE_MS` cannot be used.
  //
  // Until generator 1.3.2 that meant no call at all. For a 1-2 in technique
  // names the third power-coast variant comes to 12.6 s against a 12 s cap,
  // so about one draw in three left 60-80 s of jab-cross with no word that it
  // was deliberate. This sweep found it on its first run, 2026-11-25. The
  // mandatory pass now asks `pickCallout` for a variant that fits.

  it('still has a power-coast variant too long for the cap — the fallback is what covers it', () => {
    const { tail, variants } = SETUP_PATTERNS['co-power-coast']
    const reserveMsFor = fillOptionsForRecipe(defaultRecipe()).setupCallouts?.reserveMsFor
    expect(reserveMsFor).toBeDefined()

    const priced = Array.from({ length: variants }, (_, i) =>
      reserveMsFor?.(`co-power-coast-0${i + 1}`, '1-2', tail),
    )
    // If this changes, a clip was re-rendered or the cap moved. The test
    // below is the one that matters; this one says why the fallback exists.
    expect(priced.map((ms) => ms !== undefined && ms <= MAX_CALLOUT_RESERVE_MS)).toEqual([
      true,
      true,
      false,
    ])
  })

  it('announces every same-move stretch longer than a minute', () => {
    const unannounced = PUNCH_SETS.flatMap((punches) =>
      CAPS.flatMap((cap) => ofRule(violationsFor(punches, cap), 'announced')),
    )
    expect(unannounced).toEqual([])
  })
})
