/**
 * Telling the two gloves apart without their addresses.
 *
 * The tablet app knows left from right by BLE address (`KNOWN_TRACKERS`). A
 * browser hides addresses, so on the PC the hand comes from which button was
 * clicked. That is easy to get wrong, and the init plan WRITES the hand to the
 * glove — so before any write, the glove check reads the standard Device
 * Information service's System ID and looks for a known address inside it.
 *
 * Many BLE stacks derive System ID from the device address: the six address
 * bytes least-significant first, with `FF FE` spliced into the middle. Whether
 * these trackers do is not known until one is read — which is part of what
 * the glove check is for. A match against a known address cannot happen by
 * accident (48 bits), so a hit is trustworthy; a miss proves nothing and the
 * button's hand stands.
 *
 * Reads only. Pure TypeScript.
 */
import { hexToBytes } from '@ble/bleBytes'
import type { KnownTracker } from '@ble/knownTrackers'

const sig = (short: string): string => `0000${short}-0000-1000-8000-00805f9b34fb`

/** Standard Device Information service (H05 lists it on these trackers). */
export const DEVICE_INFORMATION_SERVICE_UUID = sig('180a')
export const SYSTEM_ID_UUID = sig('2a23')

/**
 * The service's text characteristics. Serial Number String (0x2A25) is left
 * out on purpose: browsers refuse to read it (it is on the Web Bluetooth
 * blocklist as a tracking identifier).
 */
export const DEVICE_INFORMATION_STRINGS: ReadonlyArray<{ label: string; uuid: string }> = [
  { label: 'manufacturer', uuid: sig('2a29') },
  { label: 'model', uuid: sig('2a24') },
  { label: 'hardware revision', uuid: sig('2a27') },
  { label: 'firmware revision', uuid: sig('2a26') },
  { label: 'software revision', uuid: sig('2a28') },
]

const formatAddress = (bytes: readonly number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')

/**
 * Every address a System ID value could be carrying: the EUI-64 layout
 * (address halves around `FF FE`, either byte order), and the plain first or
 * last six bytes, either order. Returns `[]` for anything that is not eight
 * bytes of hex.
 */
export function addressesInSystemId(systemIdHex: string): string[] {
  let bytes: number[]
  try {
    bytes = [...hexToBytes(systemIdHex)]
  } catch {
    return []
  }
  if (bytes.length !== 8) return []
  const [b0, b1, b2, b3, b4, b5, b6, b7] = bytes as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const candidates: number[][] = []
  const isEui64 = (b3 === 0xfe && b4 === 0xff) || (b3 === 0xff && b4 === 0xfe)
  if (isEui64) candidates.push([b7, b6, b5, b2, b1, b0], [b0, b1, b2, b5, b6, b7])
  const first = [b0, b1, b2, b3, b4, b5]
  const last = [b2, b3, b4, b5, b6, b7]
  candidates.push(first, [...first].reverse(), last, [...last].reverse())
  return [...new Set(candidates.map(formatAddress))]
}

/** The known tracker whose address a System ID value carries, if any. */
export function identifyGlove(
  systemIdHex: string,
  known: readonly KnownTracker[],
): KnownTracker | null {
  const found = new Set(addressesInSystemId(systemIdHex))
  return known.find((t) => found.has(t.address.trim().toUpperCase())) ?? null
}

/** A text characteristic's bytes as text, or as hex when they are not text. */
export function textFromHex(valueHex: string): string {
  let bytes: Uint8Array
  try {
    bytes = hexToBytes(valueHex)
  } catch {
    return valueHex
  }
  const trimmed = [...bytes]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === 0) trimmed.pop()
  if (trimmed.length === 0) return ''
  const printable = trimmed.every((b) => b >= 0x20 && b <= 0x7e)
  return printable ? String.fromCharCode(...trimmed) : `0x${valueHex}`
}
