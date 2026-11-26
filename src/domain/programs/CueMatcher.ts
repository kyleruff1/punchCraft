/**
 * Cue matching (#130, doc §6).
 *
 * Assigns tracker punch events to the expected punches of one cue. This is
 * the module that decides what "you hit that" means, so its restraint
 * matters more than its cleverness.
 *
 * ## What it refuses to do
 *
 * - **It never recomputes a window.** `expandTimeline` (M32-03) already
 *   applied the graces and clamped to the round's work interval, so grace
 *   arithmetic appears nowhere here. Two places computing the same window
 *   is how a punch ends up accepted on one screen and rejected on another.
 * - **It never drops an extra.** A punch the athlete threw happened,
 *   whether or not a cue was waiting for it. Extras carry their event ids
 *   through so the UI can show them and the summary can count them
 *   (doc §21, spec §13.6).
 * - **It never claims a technique the tier cannot support.** A
 *   `type-mismatch` is only possible when the decoder actually reported a
 *   type, which on FightCamp v1 it never does (D12).
 *
 * ## One clock
 *
 * A cue is written on the round's **work clock** — `scheduledStartMs`,
 * `tokenOffsetsMs` and both window bounds are work-elapsed milliseconds,
 * origin at the bell. A punch arrives stamped with the monotonic clock,
 * whose origin is arbitrary (app uptime, on the device), and a recovered
 * one also carries the tracker's own epoch time. Those are three different
 * number lines.
 *
 * So this module takes punches that have already been **placed** on the work
 * clock (`PlacedPunch`) and reads no time off the event itself. The
 * conversion happens once, where both clocks are known
 * (`WorkoutSessionClock.workElapsedAt`). It used to happen here by simply
 * subtracting a work-elapsed moment from a monotonic stamp — which made
 * `offsetMs` equal to the app's uptime at round start on every punch, and
 * went unnoticed because the fixtures derived the stamp *from* the cue.
 *
 * ## Order and greed
 *
 * Punches are matched in work-clock order, each to the earliest unfilled
 * expectation whose window contains it. One event fills at most one slot.
 * That is deliberately simple: a smarter assignment could pair punches to
 * slots more flatteringly, but the athlete's experience is sequential — the
 * first punch answers the first call — and a matcher that reorders reality
 * to raise a score is not measuring anything.
 *
 * Pure TypeScript — no React, Expo, SQLite or BLE imports, and no
 * `Date.now()` (spec §15.1, §18.3).
 */

import type { CapabilityTier } from '../workout/capabilityTier'
import { tierScoresTechnique } from '../workout/capabilityTier'
import type { CueInstance, ExpectedPunch } from './CueTimeline'
import type { PunchType, TrackerPunchEvent } from '../punch/PunchEvent'
import type { WorkElapsedMs } from '../time/clockDomains'

export type MatchOutcome = 'matched' | 'hand-mismatch' | 'type-mismatch'

export interface CueAssignment {
  expectedIndex: number
  eventId: string
  outcome: MatchOutcome
  /** Signed offset from the token's scheduled moment; negative is early. */
  offsetMs: number
}

/**
 * A punch placed on the round's work clock — the only clock a cue is
 * written in.
 */
export interface PlacedPunch {
  event: TrackerPunchEvent
  /**
   * Work-elapsed ms within the round at which the punch landed, from
   * `WorkoutSessionClock.workElapsedAtPunch(event)`. Typed as round time so
   * the event's own uptime stamp cannot be put here by mistake.
   *
   * `null` when the punch cannot be placed. That is every **recovered**
   * event: it was delivered after a reconnection, so its receive time says
   * nothing about when it was thrown, and its `trackerTimestampMs` is device
   * epoch time that nothing maps onto the work clock. An unplaceable punch
   * is set aside as an extra rather than guessed into a slot (H12, doc §6).
   */
  workElapsedMs: WorkElapsedMs | null
}

export interface CueExtra {
  eventId: string
  /**
   * When the event was **received**, on the monotonic clock — the same
   * meaning as `LiveExtra.eventTimeMs`. Not a work-clock time: it is carried
   * for ordering and display against other monotonic stamps, never for
   * arithmetic against the cue.
   */
  eventTimeMs: number
  /**
   * Why this punch earned no slot, when the reason is known.
   *
   * `'hand-mismatch'` means it answered a live expectation with the wrong
   * glove. Since D18 that no longer consumes the ordinal — the athlete may
   * still answer it — so the punch lands here rather than as an assignment.
   * Recording the reason is what keeps "threw it with the wrong hand"
   * distinguishable from "never threw it", which the assignment list alone can
   * no longer tell apart.
   */
  reason?: 'hand-mismatch'
}

export interface CueMatchResult {
  cueId: string
  assignments: CueAssignment[]
  missedExpectedIndexes: number[]
  /** Punches with no slot. Visible, never merged away (doc §21). */
  extras: CueExtra[]
  capabilityTier: CapabilityTier
  /** Every decoder that contributed, so a result stays recalculable. */
  decoderVersions: string[]
}

/**
 * When an expectation's token was scheduled to land, in work-elapsed ms.
 *
 * The reference for the signed match offset. Exported so the live pass can
 * report the same offset the settled pass will, from this one definition —
 * a second copy of the arithmetic is how the on-beat haptic came to disagree
 * with the score.
 *
 * M39-V1c plumbing (2026-08-30): engine mode returns the authored
 * expected-strike time. The V1c `expectedStrikeOffsetsMs` override retired in
 * Phase 5-ii — engine authoring now lives on
 * `SpineSchedule.compiled[cueId].strikes[i].targetStrikeTick`, and consumers
 * that want the engine grid read that field directly. Legacy cues use the
 * beat-grid offset.
 */
export function tokenScheduledMs(cue: CueInstance, expected: ExpectedPunch): number {
  return cue.scheduledStartMs + (cue.tokenOffsetsMs[expected.tokenIndex] ?? 0)
}

export class CueMatcher {
  private readonly tier: CapabilityTier

  constructor(tier: CapabilityTier) {
    this.tier = tier
  }

  /**
   * @param punches the cue's punches, each already placed on the work clock.
   * @param opts.gate how a punch qualifies for the cue.
   *
   * `'window'` (the default) keeps the original rule: the punch must land
   * inside the cue's acceptance window. `'open'` credits any event the caller
   * supplies, because the caller already scoped them — `LiveCueMatcher` only
   * buffers events that arrived while the cue's window was open, so re-testing
   * the times here would apply a stricter rule than the live pass and
   * manufacture a correction on every set (D18).
   *
   * The two passes **must** agree. A divergence is not a cosmetic difference:
   * `LiveCueMatcher.correctionsFor` diffs them, and every mismatch is logged as
   * a corrected match.
   */
  match(
    cue: CueInstance,
    punches: readonly PlacedPunch[],
    opts: { gate?: 'window' | 'open' } = {},
  ): CueMatchResult {
    const gate = opts.gate ?? 'window'
    const assignments: CueAssignment[] = []
    const extras: CueExtra[] = []
    const filled = new Set<number>()
    const decoderVersions = new Set<string>()

    // Order by when each punch landed in the round. One that could not be
    // placed on the work clock is unorderable, so it is set aside as an
    // extra rather than being slotted by its arrival.
    const timed: Array<{ event: TrackerPunchEvent; atMs: number }> = []
    for (const { event, workElapsedMs } of punches) {
      decoderVersions.add(event.decoderVersion)
      if (workElapsedMs === null) {
        extras.push({ eventId: event.id, eventTimeMs: event.receivedMonotonicTimeMs })
        continue
      }
      timed.push({ event, atMs: workElapsedMs })
    }
    timed.sort((a, b) => a.atMs - b.atMs || a.event.id.localeCompare(b.event.id))

    // `atMs` is work-elapsed from here down — the cue's own clock, so it may
    // be compared with the window and subtracted from a scheduled moment.
    // An extra's `eventTimeMs` is the monotonic receive stamp instead: it
    // leaves this module, and nothing outside may mistake it for round time.
    for (const { event, atMs } of timed) {
      // Windows arrive already clamped from expandTimeline — no grace math
      // here, deliberately. Under `gate: 'open'` the caller has already scoped
      // the events to the cue's open window, so the test is skipped rather
      // than applied twice.
      if (gate === 'window' && (atMs < cue.windowStartMs || atMs > cue.windowEndMs)) {
        extras.push({ eventId: event.id, eventTimeMs: event.receivedMonotonicTimeMs })
        continue
      }

      const expectedIndex = this.nextUnfilledIndex(cue, filled)
      if (expectedIndex === null) {
        // Every slot is taken: the athlete threw more than was called. That
        // is information, not an error (doc §21).
        extras.push({ eventId: event.id, eventTimeMs: event.receivedMonotonicTimeMs })
        continue
      }

      const expected = cue.expectedPunches[expectedIndex] as ExpectedPunch
      const outcome = this.outcomeFor(expected, event)

      // A wrong hand leaves the ordinal open for a retry (D18), matching the
      // live pass. Without this the two disagree on every hand error.
      if (outcome === 'hand-mismatch') {
        extras.push({
          eventId: event.id,
          eventTimeMs: event.receivedMonotonicTimeMs,
          reason: 'hand-mismatch',
        })
        continue
      }

      filled.add(expectedIndex)
      assignments.push({
        expectedIndex,
        eventId: event.id,
        outcome,
        offsetMs: atMs - tokenScheduledMs(cue, expected),
      })
    }

    const missedExpectedIndexes = cue.expectedPunches
      .map((_, index) => index)
      .filter((index) => !filled.has(index))

    return {
      cueId: cue.id,
      assignments,
      missedExpectedIndexes,
      extras,
      capabilityTier: this.tier,
      decoderVersions: [...decoderVersions].sort(),
    }
  }

  // -------------------------------------------------------------------------

  private nextUnfilledIndex(cue: CueInstance, filled: ReadonlySet<number>): number | null {
    for (let i = 0; i < cue.expectedPunches.length; i++) {
      if (!filled.has(i)) return i
    }
    return null
  }

  /**
   * Hand first, then technique — and technique only when the tier supports
   * it. A hand mismatch and a type mismatch are separate outcomes (doc §6):
   * throwing the wrong hand is a different mistake from throwing the right
   * hand with the wrong technique, and collapsing them would tell the
   * athlete nothing actionable.
   */
  private outcomeFor(expected: ExpectedPunch, event: TrackerPunchEvent): MatchOutcome {
    if (event.hand !== expected.hand) return 'hand-mismatch'

    if (!tierScoresTechnique(this.tier)) return 'matched'

    const observed = event.punchType
    // No reported technique means nothing to disagree with. On FightCamp v1
    // this is always the case, so `type-mismatch` is unreachable (D12).
    if (!isReportedType(observed)) return 'matched'
    if (expected.type === undefined) return 'matched'

    return sameFamily(observed, expected.type) ? 'matched' : 'type-mismatch'
  }
}

function isReportedType(type: PunchType | undefined): type is PunchType {
  return typeof type === 'string' && type !== 'unknown'
}

/**
 * Broad-family comparison.
 *
 * `'power'` is a vendor classification, not a technique family, so it never
 * contradicts a prescribed technique (spec §12.5).
 */
function sameFamily(observed: PunchType, expectedType: PunchType): boolean {
  if (observed === 'power' || expectedType === 'power') return true
  return observed === expectedType
}

/** Convenience for callers aggregating a round. */
export function matchedCount(result: CueMatchResult): number {
  return result.assignments.filter((a) => a.outcome === 'matched').length
}
