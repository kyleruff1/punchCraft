import { KNOWN_TRACKERS } from '@ble/knownTrackers'

import { addressesInSystemId, identifyGlove, textFromHex } from '../gloveIdentity'

// The right (red) tracker's address, EA:69:2D:9C:FD:53, the way a stack that
// derives System ID from the address lays it out: least-significant byte
// first, with FF FE spliced into the middle.
const RIGHT_AS_EUI64 = '53fd9cfeff2d69ea'

describe('addressesInSystemId', () => {
  it('finds an address laid out as EUI-64, least-significant byte first', () => {
    expect(addressesInSystemId(RIGHT_AS_EUI64)).toContain('EA:69:2D:9C:FD:53')
  })

  it('finds one laid out most-significant byte first', () => {
    expect(addressesInSystemId('ea692dfffe9cfd53')).toContain('EA:69:2D:9C:FD:53')
  })

  it('also offers the plain first and last six bytes, in both orders', () => {
    const found = addressesInSystemId('d734b427d5840000')
    expect(found).toContain('D7:34:B4:27:D5:84')
    expect(addressesInSystemId('000084d527b434d7')).toContain('D7:34:B4:27:D5:84')
  })

  it.each([['not hex'], [''], ['53fd9c'], ['53fd9cfeff2d69ea00']])(
    'returns nothing for %p',
    (value) => {
      expect(addressesInSystemId(value)).toEqual([])
    },
  )
})

describe('identifyGlove', () => {
  it('names the known tracker a System ID carries', () => {
    expect(identifyGlove(RIGHT_AS_EUI64, KNOWN_TRACKERS)).toMatchObject({
      hand: 'right',
      color: 'red',
    })
  })

  it('is case-blind about the hex', () => {
    expect(identifyGlove(RIGHT_AS_EUI64.toUpperCase(), KNOWN_TRACKERS)?.hand).toBe('right')
  })

  it('says nothing for an id that carries no known address', () => {
    expect(identifyGlove('0102030405060708', KNOWN_TRACKERS)).toBeNull()
    expect(identifyGlove('garbage', KNOWN_TRACKERS)).toBeNull()
  })
})

describe('textFromHex', () => {
  it('reads printable bytes as text, dropping trailing NULs', () => {
    expect(textFromHex('48796b736f0000')).toBe('Hykso')
  })

  it('falls back to hex for bytes that are not text', () => {
    expect(textFromHex('01ff')).toBe('0x01ff')
    expect(textFromHex('zz')).toBe('zz')
  })

  it('is empty for an empty or all-NUL value', () => {
    expect(textFromHex('0000')).toBe('')
  })
})
