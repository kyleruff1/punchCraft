import { makeRng, type Rng } from '../seededRandom'
import {
  MAX_CALLOUT_RESERVE_MS,
  SETUP_PATTERNS,
  pickCallout,
  type ReserveMsFor,
} from '../setupCallouts'

/** Prices by asset name; anything not listed has no clip. */
const priceTable =
  (prices: Record<string, number>): ReserveMsFor =>
  (asset) =>
    prices[asset]

const FITS = 8_000
const TOO_LONG = MAX_CALLOUT_RESERVE_MS + 1

/** A seed whose first callout draw for a three-variant pattern is `variant`. */
function seedDrawing(variant: number): string {
  for (let i = 0; i < 500; i++) {
    const seed = `seed-${i}`
    if (1 + makeRng(seed).int(3) === variant) return seed
  }
  throw new Error(`no seed draws variant ${variant}`)
}
const drawing = (variant: number): Rng => makeRng(seedDrawing(variant))

describe('pickCallout', () => {
  it('uses the drawn variant when it fits, with its recitation and tail', () => {
    const prices = priceTable({ 'co-power-coast-02': FITS })
    expect(pickCallout('co-power-coast', drawing(2), prices, '1-2')).toEqual({
      asset: 'co-power-coast-02',
      notation: '1-2',
      tail: SETUP_PATTERNS['co-power-coast'].tail,
      reserveMs: FITS,
    })
  })

  it('skips when the drawn variant is over the cap or has no clip', () => {
    const others = { 'co-power-coast-01': FITS, 'co-power-coast-02': FITS }
    const overCap = priceTable({ ...others, 'co-power-coast-03': TOO_LONG })
    expect(pickCallout('co-power-coast', drawing(3), overCap)).toBeUndefined()
    expect(pickCallout('co-power-coast', drawing(3), priceTable(others))).toBeUndefined()
  })

  describe('mustFit', () => {
    const prices = priceTable({
      'co-power-coast-01': FITS,
      'co-power-coast-02': FITS + 1,
      'co-power-coast-03': TOO_LONG,
    })
    const mustFit = { mustFit: true }

    it('falls back to the next variant that fits, wrapping round', () => {
      expect(pickCallout('co-power-coast', drawing(3), prices, '1-2', mustFit)).toMatchObject({
        asset: 'co-power-coast-01',
        reserveMs: FITS,
        notation: '1-2',
      })
    })

    it('passes over a variant with no clip as well as one that is too long', () => {
      const gappy = priceTable({ 'co-power-coast-01': FITS, 'co-power-coast-03': TOO_LONG })
      expect(pickCallout('co-power-coast', drawing(2), gappy, undefined, mustFit)?.asset).toBe(
        'co-power-coast-01',
      )
    })

    it('leaves a drawn variant that fits alone', () => {
      expect(pickCallout('co-power-coast', drawing(2), prices, undefined, mustFit)?.asset).toBe(
        'co-power-coast-02',
      )
    })

    it('still skips when no variant can be used', () => {
      const none = priceTable({
        'co-power-coast-01': TOO_LONG,
        'co-power-coast-02': TOO_LONG,
        'co-power-coast-03': TOO_LONG,
      })
      expect(pickCallout('co-power-coast', drawing(1), none, '1-2', mustFit)).toBeUndefined()
    })

    it('stays inside a variant ceiling', () => {
      const outside = priceTable({ 'co-power-coast-01': FITS, 'co-power-coast-03': FITS })
      const picked = pickCallout('co-power-coast', drawing(2), outside, undefined, {
        mustFit: true,
        variantCeiling: 2,
      })
      expect(picked?.asset).toBe('co-power-coast-01')
    })

    it('draws from the rng exactly once, fallback or not', () => {
      const draws = (options: { mustFit: boolean }): number => {
        let count = 0
        const real = drawing(3)
        const counting: Rng = { ...real, int: (n) => ((count += 1), real.int(n)) }
        pickCallout('co-power-coast', counting, prices, '1-2', options)
        return count
      }
      expect(draws({ mustFit: true })).toBe(1)
      expect(draws({ mustFit: false })).toBe(1)
    })
  })

  it('never emits a retired pattern, and draws nothing for it', () => {
    const rng = makeRng('x')
    const untouched = makeRng('x').int(1000)
    expect(
      pickCallout('co-settle-in', rng, () => FITS, undefined, { mustFit: true }),
    ).toBeUndefined()
    expect(rng.int(1000)).toBe(untouched)
  })
})
