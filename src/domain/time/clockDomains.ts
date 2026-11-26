/**
 * The three millisecond clocks, as three types.
 *
 * Every time in this app is "a number of milliseconds", and there are three
 * unrelated things that number can be counting from:
 *
 * - **`MonotonicMs`** — app uptime, `performance.now()`. What
 *   `MonotonicClock.now()` returns and what a punch is stamped with on
 *   arrival. Orders events; means nothing as a position in a round.
 * - **`WorkElapsedMs`** — time into the current round's work interval, frozen
 *   while paused. What a cue's schedule is written in and what a punch must
 *   be placed on before it can be matched to a cue.
 * - **`TrackerEpochMs`** — the glove's own clock, set by the clock-sync write.
 *   Orders one glove's punches; not comparable to either of the others.
 *
 * As plain `number`s nothing stops one being used as another, and that is
 * not hypothetical. Until 2026-11-25 the matcher read a punch's uptime stamp
 * as its position in the round: `cue_results.offset_ms` held the app's
 * uptime on every row ever written, `timingWindowPct` was always 0, and the
 * on-beat haptic never fired. No test saw it, because fixtures started their
 * clock at zero, where the two number lines coincide.
 *
 * So each clock is a *branded* number. A branded value is still a number —
 * read it, subtract it, log it, store it, all without ceremony — but a plain
 * number, or another clock's value, cannot be put where a specific clock is
 * required. The brand exists only in the type checker; there is no runtime
 * cost and nothing to serialize.
 *
 * **Converting between clocks is a real operation, not a cast.** The only
 * way from uptime to round time is `WorkoutSessionClock.workElapsedAt`. The
 * `as…Ms` functions below are for the edges where a number first *becomes* a
 * clock reading — a clock implementation, a decoder, a row read back from
 * storage, a test fixture — never for turning one clock into another.
 *
 * Pure TypeScript — no React, Expo, SQLite or BLE imports (spec §15.1).
 */

declare const clock: unique symbol

/** App uptime: milliseconds from an arbitrary origin, never decreasing. */
export type MonotonicMs = number & { readonly [clock]: 'monotonic' }

/** Milliseconds into the current round's work interval; frozen while paused. */
export type WorkElapsedMs = number & { readonly [clock]: 'work-elapsed' }

/** Milliseconds on a tracker's own clock, as set by its last clock sync. */
export type TrackerEpochMs = number & { readonly [clock]: 'tracker-epoch' }

/** A number that IS an uptime reading: a clock implementation, a fixture. */
export const asMonotonicMs = (ms: number): MonotonicMs => ms as MonotonicMs

/** A number that IS a round-time position: a cue's schedule, a fixture. */
export const asWorkElapsedMs = (ms: number): WorkElapsedMs => ms as WorkElapsedMs

/** A number that IS a tracker timestamp: a decoder's output, a fixture. */
export const asTrackerEpochMs = (ms: number): TrackerEpochMs => ms as TrackerEpochMs
