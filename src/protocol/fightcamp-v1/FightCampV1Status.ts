/**
 * The tracker's status byte (`ca281073`), as far as the vendor's code shows
 * what it means (H14 in `docs/protocol/hypotheses.md`).
 *
 * The official app reads it at the end of its start-up and tests bit 4 of
 * the first byte. Set: it will not call the tracker ready until the OS
 * reports it bonded. Clear: it writes command 16 and waits. That is all that
 * is known — the other seven bits are unmapped, and what the firmware does
 * about the bit is not in the source.
 *
 * Shared by the tablet's keepalive, which logs it, and the PC glove check,
 * which shows it. Neither acts on it, and neither sends command 16.
 *
 * Pure constants and one function. No RN / Expo / BLE / SQLite imports.
 */

/** Bit 4 of byte 0: the vendor's bond gate. */
export const STATUS_BOND_GATE_BIT = 0x10

/** Whether the bond-gate bit is set, or null when the value cannot say. */
export function bondGateSet(statusHex: string | null | undefined): boolean | null {
  if (typeof statusHex !== 'string' || !/^[0-9a-fA-F]{2}/.test(statusHex)) return null
  return (Number.parseInt(statusHex.slice(0, 2), 16) & STATUS_BOND_GATE_BIT) !== 0
}
