/**
 * Paying for time claimed after a round is already full (generator 1.3.1).
 *
 * The "settle in" announcement for a long same-move stretch reserves 6-7 s
 * in a round that the repair pass has just filled to its bell. The time has
 * to come out of the back of the round. It used to come out as whole blocks,
 * whatever their size: measured on one round, a 6.6 s reservation dropped a
 * 2.1 s filler block and then a 25.7 s pressure block, and nothing put the
 * difference back — the round ended 15 s early.
 *
 * `trimToFit` is that payment, on hand-built rounds where the sizes are
 * known. The end-to-end sweeps are in `roundFill.test.ts`.
 */
import { blocksSpanMs, layBlocks, type BlockSpec } from '../samples/authoring'
import { comboSpecFor, trimToFit, volumeSpecFor } from '../roundFill'

const BPM = 100
const spanOf = (specs: readonly BlockSpec[]): number => blocksSpanMs(layBlocks(specs, BPM))
const sizeOf = (spec: BlockSpec): number => spanOf([spec])

const opener = (): BlockSpec => comboSpecFor('opener', '1-2', 4, 1)
const pressure = (reps = 12): BlockSpec => comboSpecFor('pressure', '1-3', reps, 1)
const filler = (id: string): BlockSpec => comboSpecFor(id, '1-3', 2, 0.8)
const flurry = (): BlockSpec => volumeSpecFor('flurry', 'open-pressure', '1-2', 12, 30, 0)

/** A round exactly full, then `owedMs` over its bell. */
const overBy = (specs: BlockSpec[], owedMs: number): number => spanOf(specs) - owedMs

describe('a block worth more than what is owed gives up reps, not itself', () => {
  it('keeps a long pressure block and takes reps off it', () => {
    // The measured case in miniature: the round owes about a third of what
    // its last authored block is worth.
    const specs = [opener(), pressure(12)]
    const owed = Math.round(sizeOf(pressure(12)) / 3)
    const workMs = overBy(specs, owed)

    trimToFit(specs, workMs, BPM, 0)

    expect(specs.map((s) => s.id)).toEqual(['opener', 'pressure'])
    expect(specs[1]?.repeat).toBeLessThan(12)
    expect(specs[1]?.repeat).toBeGreaterThanOrEqual(7)
    expect(spanOf(specs)).toBeLessThanOrEqual(workMs)
    // No more was taken than one rep beyond what was owed.
    expect(workMs - spanOf(specs)).toBeLessThan(sizeOf(pressure(1)))
  })

  it('drops the filler behind it first, then takes only the remainder in reps', () => {
    const specs = [opener(), pressure(12), filler('f1'), filler('f2')]
    const owed = sizeOf(filler('f')) * 2 + sizeOf(pressure(1)) * 2
    const workMs = overBy(specs, owed)

    trimToFit(specs, workMs, BPM, 0)

    expect(specs.map((s) => s.id)).toEqual(['opener', 'pressure'])
    expect(specs[1]?.repeat).toBeGreaterThanOrEqual(9)
    expect(spanOf(specs)).toBeLessThanOrEqual(workMs)
  })
})

describe('a block worth no more than what is owed goes whole', () => {
  it('removes trailing filler exactly, leaving the authored block untouched', () => {
    const specs = [opener(), pressure(12), filler('f1'), filler('f2'), filler('f3')]
    const workMs = overBy(specs, sizeOf(filler('f')) * 2)

    trimToFit(specs, workMs, BPM, 0)

    expect(specs.map((s) => s.id)).toEqual(['opener', 'pressure', 'f1'])
    expect(specs[1]?.repeat).toBe(12)
    expect(specs[2]?.repeat).toBe(2)
  })

  it('takes one rep off the filler at the boundary rather than a whole extra block', () => {
    const specs = [opener(), pressure(12), filler('f1'), filler('f2'), filler('f3')]
    // One and a bit fillers' worth.
    const workMs = overBy(specs, Math.round(sizeOf(filler('f')) * 1.2))

    trimToFit(specs, workMs, BPM, 0)

    expect(specs.map((s) => [s.id, s.repeat])).toEqual([
      ['opener', 4],
      ['pressure', 12],
      ['f1', 2],
      ['f2', 1],
    ])
  })
})

describe('the finale is kept when something before it can pay', () => {
  it('leaves a closing flurry in place and takes reps from the block before it', () => {
    const specs = [opener(), pressure(12), flurry()]
    const workMs = overBy(specs, sizeOf(pressure(1)) * 2)

    trimToFit(specs, workMs, BPM, 0)

    expect(specs.map((s) => s.id)).toEqual(['opener', 'pressure', 'flurry'])
    expect(specs[1]?.repeat).toBeLessThan(12)
    expect(spanOf(specs)).toBeLessThanOrEqual(workMs)
  })

  it('drops the flurry only when nothing can give a rep', () => {
    const specs = [comboSpecFor('opener', '1-2', 1, 1), flurry()]
    const workMs = overBy(specs, 1_000)

    trimToFit(specs, workMs, BPM, 0)

    expect(specs.map((s) => s.id)).toEqual(['opener'])
  })
})

describe('what it will not touch', () => {
  it('does nothing to a round that already fits', () => {
    const specs = [opener(), pressure(12), filler('f1')]
    const before = JSON.stringify(specs)
    trimToFit(specs, spanOf(specs), BPM, 0)
    expect(JSON.stringify(specs)).toBe(before)
  })

  it('never takes from a block before the floor', () => {
    const specs = [opener(), pressure(12), filler('f1')]
    // Owe more than everything after the floor can give.
    const workMs = overBy(specs, sizeOf(filler('f')) + sizeOf(pressure(12)))

    trimToFit(specs, workMs, BPM, 1)

    expect(specs[0]).toEqual(opener())
    // The block AT the floor is trimmed to a rep but never removed.
    expect(specs.map((s) => [s.id, s.repeat])).toEqual([
      ['opener', 4],
      ['pressure', 1],
    ])
  })
})
