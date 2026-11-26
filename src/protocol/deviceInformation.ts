/**
 * The standard Bluetooth Device Information service (0x180A), which the
 * trackers expose (H05) and the official app reads in full before it starts a
 * session (H14): six strings, of which the firmware revision picks its record
 * width and the serial number is how it tells one tracker from another.
 *
 * Pure. No RN / Expo / BLE / SQLite imports.
 */

const sig = (short: string): string => `0000${short}-0000-1000-8000-00805f9b34fb`

export const DEVICE_INFORMATION_SERVICE_UUID = sig('180a')

/** Eight bytes. Often derived from the device address; the vendor never reads it. */
export const SYSTEM_ID_UUID = sig('2a23')

/**
 * Serial Number String. Readable on Android; a browser refuses it (it is on
 * the Web Bluetooth blocklist as a tracking identifier), so the PC glove
 * check leaves it out.
 */
export const SERIAL_NUMBER_UUID = sig('2a25')

/** The text characteristics every central may read. */
export const DEVICE_INFORMATION_STRINGS: ReadonlyArray<{ label: string; uuid: string }> = [
  { label: 'manufacturer', uuid: sig('2a29') },
  { label: 'model', uuid: sig('2a24') },
  { label: 'hardware revision', uuid: sig('2a27') },
  { label: 'firmware revision', uuid: sig('2a26') },
  { label: 'software revision', uuid: sig('2a28') },
]

/** A text characteristic's bytes as text, or as hex when they are not text. */
export function textFromHex(valueHex: string): string {
  if (!/^([0-9a-fA-F]{2})*$/.test(valueHex)) return valueHex
  const bytes = (valueHex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16))
  while (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes.pop()
  if (bytes.length === 0) return ''
  const printable = bytes.every((b) => b >= 0x20 && b <= 0x7e)
  return printable ? String.fromCharCode(...bytes) : `0x${valueHex}`
}
