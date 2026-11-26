/**
 * The tracker's status byte (`ca281073`), as far as the vendor's code shows
 * what it means (H14 in `docs/protocol/hypotheses.md`).
 *
 * The official app reads it at the end of its start-up and tests bit 4 of
 * the first byte. Set: it will not call the tracker ready until the OS
 * reports it bonded. Clear: it writes command 16 and waits. That is the whole
 * of what is known — the other seven bits are unmapped, and what the firmware
 * does about the bit is not in the source.
 *
 * So the glove check reads it — a read costs nothing and breaks no rule — and
 * says what the vendor would do next. It never does it: command 16 is not
 * sent from here, or from anywhere in punchCraft.
 *
 * Pure TypeScript.
 */
import { bondGateSet } from '@protocol/fightcamp-v1/FightCampV1Status'

// The bit itself is the protocol layer's; the tablet keepalive logs the same one.
export { STATUS_BOND_GATE_BIT, bondGateSet } from '@protocol/fightcamp-v1/FightCampV1Status'

/** One status reading in words. */
export function statusSentence(statusHex: string | null): string {
  const gate = bondGateSet(statusHex)
  if (statusHex === null) return 'not read'
  if (gate === null) return `0x${statusHex} (not a status byte)`
  return gate
    ? `0x${statusHex}: bit 4 set — the official app would require an OS bond here`
    : `0x${statusHex}: bit 4 clear — the official app would send command 16 here; this page never does`
}
