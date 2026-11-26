/**
 * Recognising a glove that is not bonded, from how its link dies (H13).
 *
 * A FightCamp v1 tracker sends an SMP Security Request about four seconds
 * after it connects. If the central is not bonded to it, that procedure
 * times out thirty seconds later and the link drops — at roughly 37 s,
 * cleanly, whatever else was happening on it. Traffic does not prevent it.
 * To the athlete it looks like "connects, works, then drops", every time,
 * with nothing to say why.
 *
 * Neither transport can ask the question directly: the tablet's BLE library
 * has no bond API, and a web page has none either. What both can see is the
 * signature. This module is that recognition and nothing else — pure, so
 * the tablet app and the PC glove check share one definition of it.
 *
 * It is deliberately slow to accuse. One drop in the window is `suspect`;
 * it takes two in a row to say `probably-unbonded`, because a single
 * disconnect at 37 s can be a coincidence and "go and re-pair your gloves"
 * is an annoying thing to be told wrongly. A link that survives the window
 * clears the suspicion.
 *
 * Not to be confused with the idle hang-up (`trackerKeepalive.ts`): that one
 * comes at 60-90 s or later and traffic cures it.
 *
 * Pure TypeScript — no React, Expo, SQLite or BLE-library imports.
 */

/** A clean drop this long after the link came ready is the signature. */
export const UNBONDED_DROP_WINDOW_MS = { min: 30_000, max: 45_000 } as const

/** How many signature drops in a row before saying so. */
export const UNBONDED_DROPS_TO_ACCUSE = 2

export type BondVerdict =
  /** Nothing to go on yet. */
  | 'unknown'
  /** One drop inside the window. Could be coincidence. */
  | 'suspect'
  /** Repeated drops inside the window: almost certainly not bonded. */
  | 'probably-unbonded'
  /** The link outlived the window, so the security procedure succeeded. */
  | 'holding'

export interface BondDiagnosis {
  /** When the current link came ready, or null while there is none. */
  readyAtMs: number | null
  /** Signature drops in a row, not counting any link that held. */
  signatureDrops: number
  verdict: BondVerdict
}

export function initialBondDiagnosis(): BondDiagnosis {
  return { readyAtMs: null, signatureDrops: 0, verdict: 'unknown' }
}

/** The link came ready. Keeps any suspicion earned by earlier drops. */
export function linkReady(state: BondDiagnosis, atMs: number): BondDiagnosis {
  return { ...state, readyAtMs: atMs }
}

/**
 * The link dropped.
 *
 * `clean` is whether it ended without an error — a timeout looks like an
 * ordinary disconnect, while a radio fault or a failed connect is something
 * else and proves nothing about bonding.
 */
export function linkDropped(state: BondDiagnosis, atMs: number, clean: boolean): BondDiagnosis {
  if (state.readyAtMs === null) return state
  const heldMs = atMs - state.readyAtMs
  const { min, max } = UNBONDED_DROP_WINDOW_MS

  if (clean && heldMs >= min && heldMs <= max) {
    const signatureDrops = state.signatureDrops + 1
    return {
      readyAtMs: null,
      signatureDrops,
      verdict: signatureDrops >= UNBONDED_DROPS_TO_ACCUSE ? 'probably-unbonded' : 'suspect',
    }
  }
  // Past the window, the security procedure had already succeeded: this is
  // some other disconnect, and it clears the suspicion. Before the window,
  // or with an error, it says nothing either way — keep what was known.
  if (heldMs > max) return { readyAtMs: null, signatureDrops: 0, verdict: 'unknown' }
  return { ...state, readyAtMs: null }
}

/**
 * The verdict as of `nowMs`, for a link that may still be up: once it has
 * outlived the window it is `holding`, whatever came before.
 */
export function bondVerdictAt(state: BondDiagnosis, nowMs: number): BondVerdict {
  if (state.readyAtMs !== null && nowMs - state.readyAtMs > UNBONDED_DROP_WINDOW_MS.max) {
    return 'holding'
  }
  return state.verdict
}

/**
 * Fold "the link is still up at `nowMs`" into the state, so a link that held
 * also forgets earlier drops. Call it on any later event for that link.
 */
export function linkStillUp(state: BondDiagnosis, nowMs: number): BondDiagnosis {
  return bondVerdictAt(state, nowMs) === 'holding'
    ? { ...state, signatureDrops: 0, verdict: 'holding' }
    : state
}
