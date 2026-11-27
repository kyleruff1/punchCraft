/**
 * What the live screen counted during a workout — kept with the saved
 * session so its summary can say what the athlete actually saw.
 *
 * The cue results a session stores cover only punches that answered a
 * called combination. The live counter counts every punch: burst output,
 * extras, punches between cues. Those exist nowhere once the workout ends
 * unless they are written down then, which is what this is (migration 009).
 *
 * A stored row is JSON, and JSON has no types: `parseLiveCounts` checks it
 * field by field and returns null for anything it does not trust. Null also
 * means "saved by an older build" — a screen shows *not recorded*, never
 * zero, in both cases.
 *
 * Pure: no storage, no React.
 */

export const LIVE_COUNTS_VERSION = 1

/** One round as its bell card showed it. */
export interface LiveRoundCount {
  roundIndex: number
  /** Punches counted during the round. */
  actual: number
  target: number
  left: number
  right: number
}

export interface LiveCounts {
  v: typeof LIVE_COUNTS_VERSION
  /** Every punch the live counter counted. */
  total: number
  left: number
  right: number
  /** Punches that answered no expectation and no burst. */
  extra: number
  /** Times the plan adapted during THIS session. */
  adaptations: number
  /** Where the punches came from. A simulated session is not training. */
  source: 'tracker' | 'simulated'
  /** Only the rounds that were reached, in order. */
  rounds: LiveRoundCount[]
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

function parseRound(value: unknown): LiveRoundCount | null {
  if (typeof value !== 'object' || value === null) return null
  const { roundIndex, actual, target, left, right } = value as Record<string, unknown>
  return isCount(roundIndex) &&
    isCount(actual) &&
    isCount(target) &&
    isCount(left) &&
    isCount(right)
    ? { roundIndex, actual, target, left, right }
    : null
}

/**
 * The stored column, checked. Null for an absent column, unreadable JSON, a
 * version this build does not know, or any field that is not what it should
 * be — one bad field distrusts the whole record rather than half of it.
 */
export function parseLiveCounts(json: string | null | undefined): LiveCounts | null {
  if (json === null || json === undefined) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { v, total, left, right, extra, adaptations, source, rounds } = raw as Record<
    string,
    unknown
  >
  if (v !== LIVE_COUNTS_VERSION) return null
  if (!isCount(total) || !isCount(left) || !isCount(right)) return null
  if (!isCount(extra) || !isCount(adaptations)) return null
  if (source !== 'tracker' && source !== 'simulated') return null
  if (!Array.isArray(rounds)) return null
  const parsedRounds: LiveRoundCount[] = []
  for (const round of rounds) {
    const parsed = parseRound(round)
    if (parsed === null) return null
    parsedRounds.push(parsed)
  }
  return { v, total, left, right, extra, adaptations, source, rounds: parsedRounds }
}
