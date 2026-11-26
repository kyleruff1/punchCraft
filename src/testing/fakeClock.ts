/**
 * Deterministic `MonotonicClock` for tests.
 *
 * Time only moves when a test moves it. `advance(ms)` fires every callback
 * whose due time falls inside the interval, **in due-time order**, and each
 * callback observes `now()` equal to its own due time rather than the end of
 * the interval — so a callback that schedules another callback lands at the
 * right place instead of being pushed to the end of the jump.
 *
 * Not a jest mock: the sim, the cue engine and the workout clock all take a
 * `MonotonicClock`, so one shared fake keeps their suites consistent.
 */
import { asMonotonicMs } from '@domain/time/clockDomains'
import type { CancelScheduled, MonotonicClock } from '@domain/time/MonotonicClock'

interface Scheduled {
  id: number
  dueAtMs: number
  callback: () => void
}

export interface FakeClock extends MonotonicClock {
  /** Move time forward, firing everything that comes due. */
  advance(ms: number): void
  /** Jump straight to an absolute time. Must not move backwards. */
  advanceTo(timeMs: number): void
  /** Callbacks still waiting. */
  pendingCount(): number
}

/**
 * Where a fake clock starts unless a test says otherwise: an hour, two
 * minutes and 3.004 seconds of "app uptime".
 *
 * Deliberately not zero. `MonotonicClock.now()` is milliseconds from an
 * arbitrary origin — `performance.now()`, app uptime, on the device — while
 * a round's work clock, a cue's schedule and a session's elapsed time all
 * count from their own starts. At origin 0 those are close to one number
 * line, so code that subtracts a monotonic stamp from a work-clock moment
 * passes every test and is wrong on every device. That is exactly how
 * `cue_results.offset_ms` came to hold the app's uptime for every punch.
 *
 * Deliberately not round either, so it cannot satisfy a tick-alignment or
 * `% 1000` assumption by accident.
 *
 * A test that needs a particular reading should pass its own `startMs`, or
 * better, measure from `clock.now()` at the moment it starts.
 */
export const DEFAULT_FAKE_CLOCK_ORIGIN_MS = 3_723_004

export function createFakeClock(startMs = DEFAULT_FAKE_CLOCK_ORIGIN_MS): FakeClock {
  let current = startMs
  let nextId = 0
  let scheduled: Scheduled[] = []

  function fire(untilMs: number): void {
    // Re-scan each pass: a callback may schedule more work inside the same
    // window, and that work must still run in due-time order.
    for (;;) {
      const due = scheduled
        .filter((s) => s.dueAtMs <= untilMs)
        .sort((a, b) => a.dueAtMs - b.dueAtMs || a.id - b.id)
      const next = due[0]
      if (!next) break
      scheduled = scheduled.filter((s) => s.id !== next.id)
      current = next.dueAtMs
      next.callback()
    }
    current = untilMs
  }

  return {
    now: () => asMonotonicMs(current),

    schedule(delayMs: number, callback: () => void): CancelScheduled {
      const id = nextId++
      scheduled.push({ id, dueAtMs: current + Math.max(0, delayMs), callback })
      return () => {
        scheduled = scheduled.filter((s) => s.id !== id)
      }
    },

    advance(ms: number): void {
      if (ms < 0) throw new Error('FakeClock cannot move backwards')
      fire(current + ms)
    },

    advanceTo(timeMs: number): void {
      if (timeMs < current) throw new Error('FakeClock cannot move backwards')
      fire(timeMs)
    },

    pendingCount: () => scheduled.length,
  }
}
