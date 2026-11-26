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

describe('KNOWN DEFECT (N-6): a long same-move stretch can go unannounced', () => {
  // Found by this sweep on its first run, 2026-11-25. Not fixed here because
  // the fix changes what the generator emits, which needs a version bump.
  //
  // A run of one combination longer than a minute must open with a "coast"
  // call (Kyle's rule). `pickCallout` draws one of the pattern's variants
  // and prices it — sentence, recitation of the combination, tail — and
  // returns nothing when the total is over `MAX_CALLOUT_RESERVE_MS`. For a
  // 1-2 in technique names, the third power-coast variant comes to 12.6 s
  // against a 12 s cap. So about one draw in three, the stretch is simply
  // not announced: 60-80 s of jab-cross with no word that it is deliberate.
  //
  // Ways out, any one: fall back to a variant that fits instead of skipping;
  // re-render the long sentence shorter; raise the cap for this pattern.

  it('is caused by one power-coast variant that cannot fit the reserve cap', () => {
    const { tail, variants } = SETUP_PATTERNS['co-power-coast']
    const reserveMsFor = fillOptionsForRecipe(defaultRecipe()).setupCallouts?.reserveMsFor
    expect(reserveMsFor).toBeDefined()

    const priced = Array.from({ length: variants }, (_, i) =>
      reserveMsFor?.(`co-power-coast-0${i + 1}`, '1-2', tail),
    )
    // This states what is true today. When it stops being true the defect is
    // probably fixed: delete this test and drop `.failing` from the next one.
    expect(priced.map((ms) => ms !== undefined && ms <= MAX_CALLOUT_RESERVE_MS)).toEqual([
      true,
      true,
      false,
    ])
  })

  // `it.failing` passes while the body fails, and FAILS the day it passes —
  // which is the reminder to make this an ordinary test.
  it.failing('announces every same-move stretch longer than a minute', () => {
    const unannounced = PUNCH_SETS.flatMap((punches) =>
      CAPS.flatMap((cap) => ofRule(violationsFor(punches, cap), 'announced')),
    )
    expect(unannounced).toEqual([])
  })
})
