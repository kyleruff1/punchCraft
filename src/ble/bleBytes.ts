/**
 * Byte helpers for the BLE transports — hex, base64 and byte arrays.
 *
 * Pure JavaScript on purpose: React Native has no `Buffer`, and `atob` /
 * `btoa` are not present on every runtime these run on. They lived inside
 * `BleManagerBlePlxImpl` until the Web Bluetooth transport needed them too;
 * that module imports the native BLE library when it loads, so nothing a
 * browser runs can import from it.
 *
 * No imports. Nothing here knows about any BLE library.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {}
  for (let i = 0; i < BASE64_ALPHABET.length; i++) map[BASE64_ALPHABET.charAt(i)] = i
  return map
})()

export class Base64DecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Base64DecodeError'
  }
}

export class HexDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HexDecodeError'
  }
}

/** Pure-JS hex → base64. Accepts optional whitespace/':' separators. Throws
 * HexDecodeError on odd length or any non-hex character. */
export function hexToBase64(hex: string): string {
  if (typeof hex !== 'string') throw new HexDecodeError('hex input is not a string')
  const clean = hex.replace(/[\s:]/g, '')
  if (clean.length % 2 !== 0) throw new HexDecodeError('hex input has odd length')
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 2) {
    const pair = clean.substring(i, i + 2)
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
      throw new HexDecodeError(`invalid hex pair at index ${i}`)
    }
    bytes.push(parseInt(pair, 16))
  }
  let out = ''
  let i = 0
  while (i < bytes.length) {
    // bytes[i] is safe because the while() guard; the two conditionals for
    // b2/b3 gate on i-vs-length before advancing. tsconfig has
    // noUncheckedIndexedAccess so we assert non-null explicitly here.
    const b1 = bytes[i++]!
    const b2 = i < bytes.length ? bytes[i++]! : -1
    const b3 = i < bytes.length ? bytes[i++]! : -1
    const c1 = b1 >> 2
    const c2 = ((b1 & 0x03) << 4) | (b2 === -1 ? 0 : b2 >> 4)
    const c3 = b2 === -1 ? -1 : ((b2 & 0x0f) << 2) | (b3 === -1 ? 0 : b3 >> 6)
    const c4 = b3 === -1 ? -1 : b3 & 0x3f
    out += BASE64_ALPHABET.charAt(c1)
    out += BASE64_ALPHABET.charAt(c2)
    out += c3 === -1 ? '=' : BASE64_ALPHABET.charAt(c3)
    out += c4 === -1 ? '=' : BASE64_ALPHABET.charAt(c4)
  }
  return out
}

/** Pure-JS base64 → hex. Ignores '=' padding. Throws Base64DecodeError on
 * any non-alphabet character so the caller can catch a typed error. */
export function base64ToHex(b64: string): string {
  if (typeof b64 !== 'string') throw new Base64DecodeError('base64 input is not a string')
  let hex = ''
  let buffer = 0
  let bits = 0
  for (let i = 0; i < b64.length; i++) {
    const ch = b64.charAt(i)
    if (ch === '=') continue
    const val = BASE64_LOOKUP[ch]
    if (val === undefined) {
      throw new Base64DecodeError(`invalid base64 character at index ${i}`)
    }
    buffer = (buffer << 6) | val
    bits += 6
    if (bits >= 8) {
      bits -= 8
      const byte = (buffer >> bits) & 0xff
      hex += byte.toString(16).padStart(2, '0')
    }
  }
  return hex
}

/** Bytes → lowercase hex, no separators. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** Hex → bytes. Same rules as `hexToBase64`: separators allowed, anything else throws. */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string') throw new HexDecodeError('hex input is not a string')
  const clean = hex.replace(/[s:]/g, '')
  if (clean.length % 2 !== 0) throw new HexDecodeError('hex input has odd length')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < clean.length; i += 2) {
    const pair = clean.substring(i, i + 2)
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) throw new HexDecodeError(`invalid hex pair at index ${i}`)
    out[i / 2] = parseInt(pair, 16)
  }
  return out
}
