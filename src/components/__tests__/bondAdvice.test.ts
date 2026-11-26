import { glovesToPair, looksUnbonded, pairingHint } from '../bondAdvice'

describe('looksUnbonded', () => {
  it('speaks only for the accusing verdict', () => {
    expect(looksUnbonded('probably-unbonded', 'dormant')).toBe(true)
    for (const verdict of ['unknown', 'suspect', 'holding'] as const) {
      expect(looksUnbonded(verdict, 'dormant')).toBe(false)
    }
  })

  it('speaks for a slot that is down, in error, or gone', () => {
    expect(looksUnbonded('probably-unbonded', 'error')).toBe(true)
    expect(looksUnbonded('probably-unbonded', undefined)).toBe(true)
  })

  it('stays quiet while the glove is up or coming up — nothing has disproved it yet', () => {
    for (const state of ['ready', 'streaming', 'connecting', 'bonding', 'recovering'] as const) {
      expect(looksUnbonded('probably-unbonded', state)).toBe(false)
    }
  })
})

describe('glovesToPair', () => {
  const down = { left: undefined, right: undefined }

  it('lists the gloves to mention, left first', () => {
    expect(glovesToPair({ left: 'unknown', right: 'unknown' }, down)).toEqual([])
    expect(glovesToPair({ left: 'holding', right: 'probably-unbonded' }, down)).toEqual(['right'])
    expect(glovesToPair({ left: 'probably-unbonded', right: 'probably-unbonded' }, down)).toEqual([
      'left',
      'right',
    ])
  })

  it('leaves out a glove that is connected again', () => {
    const bond = { left: 'probably-unbonded', right: 'probably-unbonded' } as const
    expect(glovesToPair(bond, { left: 'ready', right: 'dormant' })).toEqual(['right'])
  })
})

describe('pairingHint', () => {
  it('says which glove, what it did, and what to do', () => {
    expect(pairingHint(['left'])).toBe(
      'The left glove dropped 30–45 seconds after connecting, twice in a row. ' +
        'It is probably not paired with this tablet — tap Fix, then pair “FightCam” in Bluetooth settings.',
    )
  })

  it('covers both gloves in one line', () => {
    expect(pairingHint(['left', 'right'])).toMatch(
      /^Both gloves dropped .* They are probably not paired/,
    )
  })

  it('is empty when there is nothing to say', () => {
    expect(pairingHint([])).toBe('')
  })
})
