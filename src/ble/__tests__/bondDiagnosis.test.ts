import {
  UNBONDED_DROPS_TO_ACCUSE,
  UNBONDED_DROP_WINDOW_MS,
  bondVerdictAt,
  initialBondDiagnosis,
  linkDropped,
  linkReady,
  linkStillUp,
  type BondDiagnosis,
} from '../bondDiagnosis'

/** One link: ready at `t0`, dropped `heldMs` later. */
function session(state: BondDiagnosis, t0: number, heldMs: number, clean = true): BondDiagnosis {
  return linkDropped(linkReady(state, t0), t0 + heldMs, clean)
}

describe('bondDiagnosis', () => {
  it('knows nothing before any link', () => {
    expect(initialBondDiagnosis().verdict).toBe('unknown')
  })

  it('is suspect after one clean drop at about 37 s', () => {
    const s = session(initialBondDiagnosis(), 1_000, 37_000)
    expect(s.verdict).toBe('suspect')
    expect(s.signatureDrops).toBe(1)
    expect(s.readyAtMs).toBeNull()
  })

  it('says probably unbonded after two in a row', () => {
    let s = session(initialBondDiagnosis(), 0, 37_200)
    s = session(s, 50_000, 36_800)
    expect(s.signatureDrops).toBe(UNBONDED_DROPS_TO_ACCUSE)
    expect(s.verdict).toBe('probably-unbonded')
  })

  it('stays accused on a third', () => {
    let s = initialBondDiagnosis()
    for (let i = 0; i < 3; i++) s = session(s, i * 60_000, 37_000)
    expect(s.verdict).toBe('probably-unbonded')
    expect(s.signatureDrops).toBe(3)
  })

  it('counts both edges of the window', () => {
    expect(session(initialBondDiagnosis(), 0, UNBONDED_DROP_WINDOW_MS.min).verdict).toBe('suspect')
    expect(session(initialBondDiagnosis(), 0, UNBONDED_DROP_WINDOW_MS.max).verdict).toBe('suspect')
  })

  describe('what must not trip it', () => {
    it.each([
      ['a drop at 10 s', 10_000, true],
      ['a drop just short of the window', UNBONDED_DROP_WINDOW_MS.min - 1, true],
      ['a drop just past the window', UNBONDED_DROP_WINDOW_MS.max + 1, true],
      ['a drop at two minutes', 120_000, true],
      ['an errored drop at 37 s', 37_000, false],
    ])('%s', (_name, heldMs, clean) => {
      const s = session(initialBondDiagnosis(), 0, heldMs, clean)
      expect(s.verdict).toBe('unknown')
      expect(s.signatureDrops).toBe(0)
    })

    it('a drop with no link to drop', () => {
      const s = linkDropped(initialBondDiagnosis(), 37_000, true)
      expect(s).toEqual(initialBondDiagnosis())
    })
  })

  it('a link that held clears the count, so two drops must be consecutive', () => {
    let s = session(initialBondDiagnosis(), 0, 37_000)
    s = session(s, 60_000, 300_000)
    expect(s.verdict).toBe('unknown')
    s = session(s, 400_000, 37_000)
    expect(s.verdict).toBe('suspect')
  })

  it('an early or errored drop neither adds to nor clears the suspicion', () => {
    let s = session(initialBondDiagnosis(), 0, 37_000)
    s = session(s, 60_000, 5_000)
    expect(s.verdict).toBe('suspect')
    s = session(s, 80_000, 37_000, false)
    expect(s.verdict).toBe('suspect')
    s = session(s, 130_000, 37_000)
    expect(s.verdict).toBe('probably-unbonded')
  })

  describe('a live link', () => {
    it('is holding once it has outlived the window', () => {
      const s = linkReady(initialBondDiagnosis(), 1_000)
      expect(bondVerdictAt(s, 1_000 + UNBONDED_DROP_WINDOW_MS.max)).toBe('unknown')
      expect(bondVerdictAt(s, 1_001 + UNBONDED_DROP_WINDOW_MS.max)).toBe('holding')
    })

    it('keeps an earlier accusation until it has outlived the window', () => {
      let s = session(initialBondDiagnosis(), 0, 37_000)
      s = session(s, 50_000, 37_000)
      s = linkReady(s, 100_000)
      expect(bondVerdictAt(s, 120_000)).toBe('probably-unbonded')
      expect(bondVerdictAt(s, 150_000)).toBe('holding')
    })

    it('linkStillUp forgets earlier drops once the link has held', () => {
      let s = session(initialBondDiagnosis(), 0, 37_000)
      s = linkReady(s, 50_000)
      expect(linkStillUp(s, 60_000)).toBe(s)
      const held = linkStillUp(s, 100_000)
      expect(held.verdict).toBe('holding')
      expect(held.signatureDrops).toBe(0)
      expect(held.readyAtMs).toBe(50_000)
    })

    it('reports no verdict change without a link', () => {
      expect(bondVerdictAt(initialBondDiagnosis(), 999_999)).toBe('unknown')
    })
  })
})
