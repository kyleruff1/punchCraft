/**
 * SharedWorkClock — the UI-thread projection of the session work clock
 * (MVP v2, GH #305).
 *
 * The one semantic that must never regress: `workElapsedMs` is
 * ACCUMULATED-WITH-HOLES, not `now - start`. The projection runs only
 * from the last publish, and a non-running clock is FROZEN however far
 * the frame timestamp advances — that is what keeps the walk still
 * through pause and rest.
 */
import {
  SHARED_WORK_CLOCK_STOPPED,
  sharedWorkClockAt,
  sharedWorkElapsedMs,
  type SharedWorkClock,
} from '../SharedWorkClock'
import { WorkoutSessionClock, type SessionRoundSpec } from '../../session/WorkoutSessionClock'
import { asMonotonicMs } from '../../time/clockDomains'
import { createFakeClock, type FakeClock } from '@testing/fakeClock'

const running = (over: Partial<SharedWorkClock> = {}): SharedWorkClock => ({
  roundIndex: 0,
  workElapsedAtPublishMs: 10_000,
  publishFrameTimestampMs: 500_000,
  running: true,
  ...over,
})

describe('sharedWorkElapsedMs', () => {
  it('projects linearly from the publish moment while running', () => {
    expect(sharedWorkElapsedMs(running(), 500_000)).toBe(10_000)
    expect(sharedWorkElapsedMs(running(), 500_250)).toBe(10_250)
    expect(sharedWorkElapsedMs(running(), 501_000)).toBe(11_000)
  })

  it('FREEZES when not running — pause and rest advance nothing', () => {
    const paused = running({ running: false })
    expect(sharedWorkElapsedMs(paused, 500_000)).toBe(10_000)
    expect(sharedWorkElapsedMs(paused, 999_999)).toBe(10_000)
  })

  it('a resume publish re-anchors — the paused interval is a hole, not a jump', () => {
    // Pause at 10s; 30s of wall time passes; resume republishes the SAME
    // elapsed with a fresh frame timestamp. Projection continues from 10s.
    const resumed = running({ workElapsedAtPublishMs: 10_000, publishFrameTimestampMs: 530_000 })
    expect(sharedWorkElapsedMs(resumed, 530_100)).toBe(10_100)
  })

  it('the stopped baseline reads 0 forever', () => {
    expect(sharedWorkElapsedMs(SHARED_WORK_CLOCK_STOPPED, 123_456_789)).toBe(0)
  })

  it('carries the enterWork overflow — round start is not assumed zero', () => {
    const withOverflow = running({ workElapsedAtPublishMs: 137, publishFrameTimestampMs: 0 })
    expect(sharedWorkElapsedMs(withOverflow, 50)).toBe(187)
  })
})

// ---------------------------------------------------------------------------
// sharedWorkClockAt — what the runner publishes
// ---------------------------------------------------------------------------

/**
 * One fake clock stands for both the runner's monotonic clock and the frame
 * stamp: on a device both are `performance.now()`.
 */
describe('sharedWorkClockAt', () => {
  const ROUNDS: SessionRoundSpec[] = [
    { workDurationMs: 10_000, restAfterMs: 5_000 },
    { workDurationMs: 10_000, restAfterMs: 0 },
  ]

  function at(countdownMs = 0) {
    const clock: FakeClock = createFakeClock()
    const session = new WorkoutSessionClock(ROUNDS, { clock, countdownMs })
    const run = (ms: number, stepMs = 50): void => {
      for (let i = 0; i < Math.ceil(ms / stepMs); i++) {
        clock.advance(stepMs)
        session.advance()
      }
    }
    const publish = (): SharedWorkClock => sharedWorkClockAt(session, clock.now(), clock.now())
    /** The rings' clock and the work clock read the same, now and later. */
    const expectOneClock = (shared: SharedWorkClock): void => {
      for (const aheadMs of [0, 16, 250, 3_000]) {
        const instant = clock.now() + aheadMs
        expect(sharedWorkElapsedMs(shared, instant)).toBe(
          session.workElapsedAt(asMonotonicMs(instant)),
        )
      }
    }
    return { clock, session, run, publish, expectOneClock }
  }

  it('reads the work clock at the instant of the stamp, not at the tick that led there', () => {
    // A round opens on a tick. Sending the bell and announcing the phase
    // takes 7 ms, and only then is the clock published. Pairing the tick's
    // reading with the later stamp left the rings 7 ms behind the calls for
    // the whole round.
    const h = at()
    h.session.start()
    h.clock.advance(7)
    const shared = h.publish()
    expect(shared).toMatchObject({ roundIndex: 0, running: true, workElapsedAtPublishMs: 7 })
    h.expectOneClock(shared)
  })

  it('carries a round-opening overflow and the time since, together', () => {
    // 700 ms steps cross a 3 000 ms lead-in at 3 500: the round is 500 ms old
    // at the tick that enters it, and 512 when it is published.
    const h = at(3_000)
    h.session.start()
    h.run(3_500, 700)
    h.clock.advance(12)
    const shared = h.publish()
    expect(shared.workElapsedAtPublishMs).toBe(512)
    h.expectOneClock(shared)
  })

  it('starts the rings at a skip between ticks, however long the publish took', () => {
    const h = at(3_000)
    h.session.start()
    h.run(1_000)
    h.clock.advance(30)
    const skippedAt = h.clock.now()
    h.session.skipCountdown()
    h.clock.advance(9)
    const shared = h.publish()
    expect(shared.publishFrameTimestampMs - shared.workElapsedAtPublishMs).toBe(skippedAt)
    h.expectOneClock(shared)
  })

  it('picks the round up where a pause left it', () => {
    const h = at()
    h.session.start()
    h.run(3_000)
    h.session.pause()
    const paused = h.publish()
    expect(paused).toMatchObject({ running: false, workElapsedAtPublishMs: 3_000 })
    h.run(30_000)
    expect(sharedWorkElapsedMs(paused, h.clock.now())).toBe(3_000)

    h.session.resume()
    h.clock.advance(5)
    const resumed = h.publish()
    expect(resumed).toMatchObject({ running: true, workElapsedAtPublishMs: 3_005 })
    h.expectOneClock(resumed)
  })

  it('holds still through a rest', () => {
    const h = at()
    h.session.start()
    h.run(10_000 + 1_000)
    h.clock.advance(20)
    const shared = h.publish()
    expect(shared).toMatchObject({ roundIndex: 0, running: false, workElapsedAtPublishMs: 10_000 })
    h.expectOneClock(shared)
  })

  it('is the stopped clock, stamped, when there is no session', () => {
    expect(sharedWorkClockAt(null, asMonotonicMs(42), 42)).toEqual({
      ...SHARED_WORK_CLOCK_STOPPED,
      publishFrameTimestampMs: 42,
    })
  })

  it('is a new frozen struct every time — never a field-wise update', () => {
    const h = at()
    h.session.start()
    const a = h.publish()
    const b = h.publish()
    expect(Object.isFrozen(a)).toBe(true)
    expect(a).not.toBe(b)
  })
})
