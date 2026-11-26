import { bondGateSet, statusSentence } from '../statusByte'

describe('bondGateSet', () => {
  it('reads bit 4 of the first byte', () => {
    expect(bondGateSet('10')).toBe(true)
    expect(bondGateSet('ff')).toBe(true)
    expect(bondGateSet('1f00')).toBe(true)
    expect(bondGateSet('00')).toBe(false)
    expect(bondGateSet('ef')).toBe(false)
    // Only the first byte: bit 4 of a later one is something else.
    expect(bondGateSet('0010')).toBe(false)
  })

  it('cannot say for a value that is missing, empty or not hex', () => {
    expect(bondGateSet(null)).toBeNull()
    expect(bondGateSet('')).toBeNull()
    expect(bondGateSet('zz')).toBeNull()
  })
})

describe('statusSentence', () => {
  it('says what the official app would do next, either way', () => {
    expect(statusSentence('10')).toBe(
      '0x10: bit 4 set — the official app would require an OS bond here',
    )
    expect(statusSentence('00')).toBe(
      '0x00: bit 4 clear — the official app would send command 16 here; this page never does',
    )
  })

  it('is plain about a value it has not got or cannot read', () => {
    expect(statusSentence(null)).toBe('not read')
    expect(statusSentence('zz')).toBe('0xzz (not a status byte)')
  })
})
