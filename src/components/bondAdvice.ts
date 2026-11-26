/**
 * What to tell the athlete about a glove that looks unbonded (H13).
 *
 * `src/ble/bondDiagnosis.ts` decides; this turns its verdict into which
 * gloves to mention and the words to use. Pure — no React — so the wording
 * and the "when" are tested without rendering anything.
 *
 * The advice is shown only while the glove is DOWN. After pairing, the first
 * 45 s of the next link still carry the old verdict (nothing has disproved
 * it yet), and telling someone their connected glove is "probably not
 * paired" would be wrong more often than right.
 */
import {
  UNBONDED_DROPS_TO_ACCUSE,
  UNBONDED_DROP_WINDOW_MS,
  type BondVerdict,
} from '@ble/bondDiagnosis'
import type { ConnectionState } from '@ble/bleTypes'

type SlotHand = 'left' | 'right'

/** A slot that is up, or on its way up. */
const LIVE: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  'ready',
  'streaming',
  'connecting',
  'bonding',
  'discovering',
  'initializing',
  'recovering',
])

/** Is this the moment to say "this glove is probably not paired"? */
export function looksUnbonded(
  verdict: BondVerdict,
  slotState: ConnectionState | undefined,
): boolean {
  return verdict === 'probably-unbonded' && !(slotState !== undefined && LIVE.has(slotState))
}

/** The gloves to mention, left first. */
export function glovesToPair(
  bond: Record<SlotHand, BondVerdict>,
  slotStates: Record<SlotHand, ConnectionState | undefined>,
): SlotHand[] {
  return (['left', 'right'] as const).filter((hand) => looksUnbonded(bond[hand], slotStates[hand]))
}

const TIMES = UNBONDED_DROPS_TO_ACCUSE === 2 ? 'twice' : `${UNBONDED_DROPS_TO_ACCUSE} times`
const WINDOW = `${UNBONDED_DROP_WINDOW_MS.min / 1000}–${UNBONDED_DROP_WINDOW_MS.max / 1000} seconds`

/** The line under the Fix button. Empty when there is nothing to say. */
export function pairingHint(hands: readonly SlotHand[]): string {
  if (hands.length === 0) return ''
  const who = hands.length === 2 ? 'Both gloves' : `The ${hands[0]} glove`
  const they = hands.length === 2 ? 'They are' : 'It is'
  return (
    `${who} dropped ${WINDOW} after connecting, ${TIMES} in a row. ` +
    `${they} probably not paired with this tablet — tap Fix, then pair “FightCam” in Bluetooth settings.`
  )
}

/** The badge's short label for a glove in that state. */
export const UNBONDED_BADGE_LABEL = 'Not paired?'
