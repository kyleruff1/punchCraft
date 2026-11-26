/**
 * The ambient capture: what it is called, and when its old ones go.
 *
 * CLAUDE.md rule 1 says every incoming BLE frame is persisted before any
 * decoder runs. Until 2026-11-26 that held only inside Velocity Lab, whose
 * three routes were the only things that opened a capture: a workout — and
 * the keepalive that decodes for the whole of the app's life — persisted no
 * raw frame at all (N-7). The ambient capture is the one that is open
 * whenever nothing more specific is: one per app launch, for as long as the
 * app runs.
 *
 * It is the first capture in this app that grows without anyone asking it
 * to, so it is also the first that needs a rule for letting go. Captures
 * someone opened on purpose — Velocity Lab's — are never pruned.
 *
 * Pure. No React, Expo, SQLite or BLE imports.
 */

/** `ble_captures.label` of an ambient capture. Velocity Lab uses its own. */
export const AMBIENT_CAPTURE_LABEL = 'connection'

export interface AmbientLimits {
  /** An ambient capture that started longer ago than this goes. */
  retentionDays: number
  /** Past this many frames in ambient captures, the oldest go first. */
  maxFrames: number
}

/**
 * A raw frame is roughly 400 bytes stored, so the frame cap is about 200 MB.
 * Ninety days is long enough to cover a decoder change and the re-run it
 * calls for. Neither has been measured against a real glove's idle traffic:
 * nobody knows how often a tracker pushes status frames while nothing is
 * happening, which is why each launch logs what the last capture held.
 */
export const AMBIENT_LIMITS: AmbientLimits = { retentionDays: 90, maxFrames: 500_000 }

export interface AmbientCaptureSummary {
  id: string
  /** Wall time. Age is a housekeeping question, not an ordering one (§3.2). */
  startedAtIso: string
  frames: number
}

/**
 * Which ambient captures to delete, given all of them.
 *
 * Anything older than the retention goes. Of the rest, the newest are kept
 * until their frames add up past the cap; everything older than that point
 * goes. A capture is kept or deleted whole — a single capture larger than
 * the cap is kept, because half a capture is worth less than none.
 */
export function ambientCapturesToPrune(
  captures: readonly AmbientCaptureSummary[],
  nowMs: number,
  limits: AmbientLimits = AMBIENT_LIMITS,
): string[] {
  const cutoffMs = nowMs - limits.retentionDays * 86_400_000
  const newestFirst = [...captures].sort(
    (a, b) => Date.parse(b.startedAtIso) - Date.parse(a.startedAtIso),
  )
  const prune: string[] = []
  let kept = 0
  let overCap = false
  for (const capture of newestFirst) {
    const startedMs = Date.parse(capture.startedAtIso)
    // An unreadable date is kept: deleting on a parse failure would be
    // deleting on a guess.
    const tooOld = Number.isFinite(startedMs) && startedMs < cutoffMs
    if (tooOld || overCap) {
      prune.push(capture.id)
      continue
    }
    kept += capture.frames
    if (kept > limits.maxFrames) overCap = true
  }
  return prune
}
