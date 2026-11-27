/**
 * Worklet-safe mirror of the SESSION work clock (MVP v2, GH #305).
 *
 * The ring walk is moving onto the UI thread: `useFrameCallback` projects
 * the beat cursor per frame instead of riding the runner's ~150-340 ms JS
 * tick — the tick that made ring fires trail the click by a measured mean
 * 209 ms / p95 547 ms at 180 BPM. The projection needs `workElapsedMs` on
 * the UI thread, and this struct is how it gets there.
 *
 * ## Why NOT the transport anchor
 *
 * `SharedTransportAnchor` mirrors the METRONOME transport, which (today)
 * only runs on `metronome.enabled` workouts. The rings run on the SESSION
 * clock (`WorkoutSessionClock.workElapsedMs`) on every workout, and the
 * two must not be conflated even once every workout carries a click — the
 * session clock is the scoring/authority clock.
 *
 * ## The load-bearing semantic: accumulated-with-holes
 *
 * `workElapsedMs` is NOT `now - workStart`. `WorkoutSessionClock`
 * accumulates per-phase deltas (`advance()`), pauses accumulate nothing,
 * and `enterWork` seeds an overflow. So the worklet cannot project from a
 * start timestamp; it projects from the LAST PUBLISH:
 *
 *   workElapsedMs = workElapsedAtPublishMs +
 *                   (frameTimestampMs - publishFrameTimestampMs)   [running]
 *   workElapsedMs = workElapsedAtPublishMs                          [else]
 *
 * The publisher re-anchors at every discontinuity — work-entered (with
 * its overflow), paused, resumed, rest-entered — and NEVER per tick, so
 * the UI thread owns smoothness between anchors. What it publishes is
 * `sharedWorkClockAt`, below: the reading and the stamp are one instant.
 *
 * ## Clock domain + atomicity
 *
 * Same contract as `SharedTransportAnchor`: `publishFrameTimestampMs` and
 * the worklet's `frameTimestampMs` must share a domain (the publisher
 * samples the same source Reanimated's frameInfo uses), and every update
 * assigns a NEW frozen struct — never field-wise mutation.
 *
 * Pure TypeScript — no Reanimated import; tests run in plain node.
 */

import type { WorkoutSessionClock } from '../session/WorkoutSessionClock'
import type { MonotonicMs } from '../time/clockDomains'

export interface SharedWorkClock {
  /** Round this clock is counting for; -1 before the first work phase. */
  roundIndex: number
  /** Session work-elapsed at the publish moment (carries enterWork overflow). */
  workElapsedAtPublishMs: number
  /** Publisher-domain timestamp of the publish; worklet frames must share it. */
  publishFrameTimestampMs: number
  /** True only during an unpaused work phase — projection is otherwise frozen. */
  running: boolean
}

/** Baseline before any round starts. */
export const SHARED_WORK_CLOCK_STOPPED: SharedWorkClock = Object.freeze({
  roundIndex: -1,
  workElapsedAtPublishMs: 0,
  publishFrameTimestampMs: 0,
  running: false,
})

/**
 * The struct to publish at a discontinuity: the session's work clock, read
 * at the instant the stamp beside it is taken.
 *
 * **The reading and the stamp are ONE instant.** The publish used to pair
 * `snapshot().workElapsedMs` — the work clock as of the last `advance()`,
 * the tick that led here — with a stamp taken later in the same tick, after
 * the bell had been sent and the phase announced. Whatever that took, the
 * rings then ran behind the work clock by, for the whole round, while the
 * calls and the ring tokens went out on the work clock itself. So this asks
 * the session for its reading at `monotonicNowMs` — `workElapsedAt`, the one
 * sanctioned conversion — which outside an unpaused work phase is the
 * frozen reading, exactly what was published before.
 *
 * `monotonicNowMs` and `frameTimestampMs` are the same moment on the
 * runner's clock and on the frame clock, read back to back by the caller.
 * On a device both are `performance.now()`.
 *
 * Plain JS-thread function — never called from a worklet.
 */
export function sharedWorkClockAt(
  session: Pick<WorkoutSessionClock, 'snapshot' | 'workElapsedAt'> | null | undefined,
  monotonicNowMs: MonotonicMs,
  frameTimestampMs: number,
): SharedWorkClock {
  if (!session) {
    return Object.freeze({
      ...SHARED_WORK_CLOCK_STOPPED,
      publishFrameTimestampMs: frameTimestampMs,
    })
  }
  const snapshot = session.snapshot()
  return Object.freeze({
    roundIndex: snapshot.roundIndex,
    workElapsedAtPublishMs: session.workElapsedAt(monotonicNowMs),
    publishFrameTimestampMs: frameTimestampMs,
    running: snapshot.phase === 'work',
  })
}

/**
 * Project the current work-elapsed ms. Plain function; when called from a
 * real worklet the `'worklet'` directive lives at the call site.
 */
export function sharedWorkElapsedMs(clock: SharedWorkClock, frameTimestampMs: number): number {
  // The directive is LOAD-BEARING, not decoration: without it the Babel
  // workletizer leaves this as a JS-thread function, and the frame
  // callback's call becomes "[Worklets] Tried to synchronously call a
  // Remote Function on the UI Runtime" — an instant red screen on
  // device, invisible to jest (which runs everything on one thread).
  // Same placement as `sharedAnchorCurrentTick`, the proven pattern.
  'worklet'
  if (!clock.running) return clock.workElapsedAtPublishMs
  return clock.workElapsedAtPublishMs + (frameTimestampMs - clock.publishFrameTimestampMs)
}
