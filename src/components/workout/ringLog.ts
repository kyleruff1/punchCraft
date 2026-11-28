/**
 * What the ring walk logs, and what it does not prove.
 *
 * `workout.ring.visual` is written on the JS thread when the UI-thread walk
 * steps to a ring; `workout.ring.promote` when it moves to a new bar. Two
 * things the bare record (`cueId`, `ordinal`) could not say, and that a check
 * of "did every ring light, and when" needs:
 *
 * **When.** The record carried no clock. On a PC the page stamps every
 * record itself; on a device there is only the log line's time — one
 * millisecond steps, and written after a hop from the UI thread that queues
 * behind whatever JS is doing. So each step now carries the two clocks the UI
 * thread had on the frame that lit the ring: the frame's own timestamp
 * (`frameMs`, the same domain as `performance.now()` and therefore as every
 * `monotonicTimeMs` in the log) and the work-elapsed it projected from the
 * ring clock (`workElapsedMs`). The frame's time against the schedule is the
 * ring's lateness. The ring clock's view against the session clock's is
 * whether the two clocks agree — a gap there is exactly what N-18 was, and
 * the ring clock judged against itself could never show it.
 *
 * **Whether light was shown.** The walk steps on every bar, including the
 * ones the app deliberately keeps dim (`CueStage` withholds the paint on a
 * masked row: a bar with no call, and the first two measures of a round).
 * Counting records therefore counted rings that were never painted. `row`
 * says which it was. `other` means the row on stage was not this bar at all
 * at the moment the step was logged.
 *
 * `from` is the ring the walk stepped from: a step from 1 to 3 stepped over
 * 2. `previousReached` on a promote is how far the bar before got — the
 * witness for "its last rings never lit" that does not depend on no log line
 * having been lost.
 *
 * Pure. No React, no Reanimated.
 */
import { safe, type ClassifiedField } from '@/diagnostics/logger'

export type RingRow = 'lit' | 'masked' | 'other'

/** The bar on stage as the JS thread knows it, or null when there is none. */
export interface StageRow {
  cueId: string
  masked: boolean
}

export interface RingStep {
  /** The bar the walk is in — its cue id. */
  epoch: string
  /** The ring stepped to; -1 clears the row for a new bar. */
  ordinal: number
  /** The ring stepped from; -1 when none was lit. */
  from: number
  /** Work-elapsed the UI thread projected on that frame, from the ring clock. */
  workElapsedMs: number
  /** That frame's timestamp. */
  frameMs: number
}

export interface BarPromotion {
  epoch: string
  /** Ring-clock time past the bar's scheduled start when the frame noticed it. */
  lateMs: number
  /** The bar before, or '' for the first of a round. */
  previousEpoch: string
  /** The last ring that bar reached; -1 if it lit none. */
  previousReached: number
  frameMs: number
}

/** A tenth of a millisecond is finer than a frame and keeps the line short. */
const tenth = (ms: number): number => Math.round(ms * 10) / 10

/** Whether the row showing this bar paints, is held dim, or is another bar's. */
export function ringRow(stage: StageRow | null, epoch: string): RingRow {
  if (stage === null || stage.cueId !== epoch) return 'other'
  return stage.masked ? 'masked' : 'lit'
}

export function ringVisualFields(
  step: RingStep,
  stage: StageRow | null,
): Record<string, ClassifiedField> {
  return {
    cueId: safe(step.epoch),
    ordinal: safe(step.ordinal),
    from: safe(step.from),
    workElapsedMs: safe(tenth(step.workElapsedMs)),
    frameMs: safe(tenth(step.frameMs)),
    row: safe(ringRow(stage, step.epoch)),
  }
}

export function ringPromoteFields(promotion: BarPromotion): Record<string, ClassifiedField> {
  return {
    cueId: safe(promotion.epoch),
    lateMs: safe(tenth(promotion.lateMs)),
    previousCueId: safe(promotion.previousEpoch),
    previousReached: safe(promotion.previousReached),
    frameMs: safe(tenth(promotion.frameMs)),
  }
}
