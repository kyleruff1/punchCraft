/** Byte helpers shared by both BLE transports. */
import {
  Base64DecodeError,
  HexDecodeError,
  base64ToHex,
  bytesToHex,
  hexToBase64,
  hexToBytes,
} from '../bleBytes'

describe('hex and base64', () => {
  it.each([
    ['', ''],
    ['01', 'AQ=='],
    ['0111', 'ARE='],
    ['01abff', 'Aav/'],
    ['deadbeef', '3q2+7w=='],
  ])('round-trips %p', (hex, base64) => {
    expect(hexToBase64(hex)).toBe(base64)
    expect(base64ToHex(base64)).toBe(hex)
  })

  it('accepts separators in hex, and upper case', () => {
    expect(hexToBase64('DE:AD be ef')).toBe('3q2+7w==')
  })

  it('refuses bad input with a typed error', () => {
    expect(() => hexToBase64('abc')).toThrow(HexDecodeError)
    expect(() => hexToBase64('zz')).toThrow(HexDecodeError)
    expect(() => base64ToHex('a*b')).toThrow(Base64DecodeError)
  })
})

describe('byte arrays', () => {
  it('round-trips bytes through hex', () => {
    const bytes = Uint8Array.from([0x00, 0x01, 0x7f, 0x80, 0xff])
    expect(bytesToHex(bytes)).toBe('00017f80ff')
    expect([...hexToBytes('00017f80ff')]).toEqual([...bytes])
  })

  it('handles the empty case', () => {
    expect(bytesToHex(new Uint8Array())).toBe('')
    expect(hexToBytes('')).toHaveLength(0)
  })

  it('refuses hex that is not hex', () => {
    expect(() => hexToBytes('0')).toThrow(HexDecodeError)
    expect(() => hexToBytes('0g')).toThrow(HexDecodeError)
  })
})
