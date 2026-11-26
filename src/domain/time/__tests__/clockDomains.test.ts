/**
 * The clock types' own test — and most of it is run by the COMPILER.
 *
 * `compileTimeOnly` below is never called. Each `@ts-expect-error` in it
 * marks a line that must not type-check; if one ever does, `tsc` fails on
 * the unused directive, and `npm run typecheck` is part of CI and of the
 * pre-push check. That is the guard: the mistake behind H-1 — a punch's
 * uptime stamp used as its position in the round — is one of these lines.
 */
import { createFakeClock } from '@testing/fakeClock'
import type { CueAnnouncer } from '../../coach/CueAnnouncer'
import type { PlacedPunch } from '../../programs/CueMatcher'
import type { LiveCueMatcher } from '../../programs/LiveCueMatcher'
import type { TrackerPunchEvent } from '../../punch/PunchEvent'
import { WorkoutSessionClock } from '../../session/WorkoutSessionClock'
import {
  asMonotonicMs,
  asTrackerEpochMs,
  asWorkElapsedMs,
  type MonotonicMs,
  type TrackerEpochMs,
  type WorkElapsedMs,
} from '../clockDomains'
import type { MonotonicClock } from '../MonotonicClock'

const takesWork = (_ms: WorkElapsedMs): void => undefined
const takesMonotonic = (_ms: MonotonicMs): void => undefined
const takesTracker = (_ms: TrackerEpochMs): void => undefined

/** Never called: the compiler checks it and nothing runs it. */
export function compileTimeOnly(
  clock: MonotonicClock,
  session: WorkoutSessionClock,
  matcher: LiveCueMatcher,
  announcer: CueAnnouncer,
  event: TrackerPunchEvent,
): void {
  const uptime = clock.now()
  const roundTime = session.snapshot().workElapsedMs
  const trackerTime = asTrackerEpochMs(5)

  // --- what the brands allow ------------------------------------------------
  takesMonotonic(uptime)
  takesWork(roundTime)
  takesWork(session.workElapsedAt(uptime))
  takesWork(session.workElapsedAtPunch(event))
  takesTracker(trackerTime)
  matcher.onPunchEvent(event, session.workElapsedAtPunch(event))
  announcer.onTick(roundTime, uptime)
  // A branded value is still a number wherever a number will do.
  const asNumber: number = uptime + roundTime
  void asNumber

  // --- what they refuse -----------------------------------------------------
  // @ts-expect-error — a plain number is on no clock at all
  takesWork(1234)
  // @ts-expect-error — uptime is not a position in the round
  takesWork(uptime)
  // @ts-expect-error — a position in the round is not uptime
  takesMonotonic(roundTime)
  // @ts-expect-error — the glove's clock is not the app's
  takesMonotonic(trackerTime)
  // @ts-expect-error — nor the round's
  takesWork(trackerTime)
  // @ts-expect-error — arithmetic gives a plain number back; re-brand on purpose
  takesMonotonic(uptime + 5)

  // --- the seams that matter ------------------------------------------------
  // @ts-expect-error — H-1 exactly: the punch's uptime stamp as its round time
  matcher.onPunchEvent(event, event.receivedMonotonicTimeMs)
  // @ts-expect-error — the same mistake, building the matcher's input by hand
  const placed: PlacedPunch = { event, workElapsedMs: event.receivedMonotonicTimeMs }
  void placed
  // @ts-expect-error — the tracker timestamp is no better
  matcher.onPunchEvent(event, event.trackerTimestampMs ?? 0)
  // @ts-expect-error — converting needs uptime in, not round time
  session.workElapsedAt(roundTime)
  // @ts-expect-error — the announcer's two clocks, swapped
  announcer.onTick(uptime, roundTime)
}

describe('the clock types', () => {
  it('are enforced by the compiler, not at runtime', () => {
    // Nothing to execute: see `compileTimeOnly`. This keeps the file a test,
    // and records that the constructors are the identity.
    expect(asMonotonicMs(42)).toBe(42)
    expect(asWorkElapsedMs(42)).toBe(42)
    expect(asTrackerEpochMs(42)).toBe(42)
    expect(typeof compileTimeOnly).toBe('function')
  })
})

describe('WorkoutSessionClock.workElapsedAtPunch', () => {
  const start = (): { clock: ReturnType<typeof createFakeClock>; session: WorkoutSessionClock } => {
    const clock = createFakeClock()
    const session = new WorkoutSessionClock([{ workDurationMs: 60_000, restAfterMs: 0 }], {
      clock,
      countdownMs: 0,
    })
    session.start()
    return { clock, session }
  }

  it('places a punch by its uptime stamp, wherever the app clock started', () => {
    const { clock, session } = start()
    clock.advance(2_500)
    session.advance()
    // Stamped 40 ms after the tick that will deliver it.
    const punch = { receivedMonotonicTimeMs: clock.now() + 40 }
    expect(session.workElapsedAtPunch(punch)).toBe(2_540)
    // Not the stamp itself, which is an hour of uptime away.
    expect(punch.receivedMonotonicTimeMs).toBeGreaterThan(3_600_000)
  })

  it('agrees with workElapsedAt on the same instant', () => {
    const { clock, session } = start()
    clock.advance(1_200)
    session.advance()
    const instant = clock.now()
    expect(session.workElapsedAtPunch({ receivedMonotonicTimeMs: instant })).toBe(
      session.workElapsedAt(instant),
    )
  })
})
