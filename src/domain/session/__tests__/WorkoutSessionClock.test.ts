/**
 * Workout session clock (M32-08 support).
 *
 * The property that matters most: a pause freezes the work clock and does
 * not shift the round. Everything the CueEngine schedules against comes
 * from here, so drift introduced at this level would be invisible until it
 * showed up as cues firing at the wrong time.
 */
import {
  WorkoutSessionClock,
  type SessionRoundSpec,
  type SessionTransition,
} from '../WorkoutSessionClock'
import { createFakeClock, type FakeClock } from '@testing/fakeClock'
import { sharedWorkElapsedMs, type SharedWorkClock } from '../../timing/SharedWorkClock'
import { asMonotonicMs } from '../../time/clockDomains'

const ROUNDS: SessionRoundSpec[] = [
  { workDurationMs: 10_000, restAfterMs: 5_000 },
  { workDurationMs: 10_000, restAfterMs: 5_000 },
  { workDurationMs: 10_000, restAfterMs: 0 },
]

function harness(rounds: SessionRoundSpec[] = ROUNDS, countdownMs = 0) {
  const clock: FakeClock = createFakeClock()
  const session = new WorkoutSessionClock(rounds, { clock, countdownMs })
  const seen: SessionTransition[] = []

  const run = (ms: number, stepMs = 100): void => {
    for (let i = 0; i < Math.ceil(ms / stepMs); i++) {
      clock.advance(stepMs)
      seen.push(...session.advance())
    }
  }

  return { clock, session, seen, run }
}

const types = (seen: SessionTransition[]): string[] => seen.map((t) => t.type)

describe('start', () => {
  it('goes straight to work when there is no countdown', () => {
    const h = harness()
    expect(h.session.start()).toEqual([{ type: 'work-entered', roundIndex: 0 }])
    expect(h.session.snapshot().phase).toBe('work')
  })

  it('runs a countdown first when configured', () => {
    const h = harness(ROUNDS, 3_000)
    expect(h.session.start()).toEqual([{ type: 'countdown-entered' }])
    expect(h.session.snapshot().phase).toBe('countdown')

    h.run(3_100)
    expect(types(h.seen)).toContain('work-entered')
    expect(h.session.snapshot().phase).toBe('work')
  })

  it('is idempotent', () => {
    const h = harness()
    h.session.start()
    expect(h.session.start()).toEqual([])
  })
})

describe('phase progression', () => {
  it('walks work → rest → work across the schedule', () => {
    const h = harness()
    h.session.start()
    h.run(10_100)
    expect(h.session.snapshot().phase).toBe('rest')

    h.run(5_100)
    expect(h.session.snapshot().phase).toBe('work')
    expect(h.session.snapshot().roundIndex).toBe(1)
  })

  it('completes after the final round when it has no rest', () => {
    const h = harness()
    h.session.start()
    h.run(60_000)
    expect(h.session.snapshot().phase).toBe('completed')
    expect(types(h.seen)).toContain('completed')
  })

  it('emits every transition even when one step crosses several boundaries', () => {
    // A dropped frame must not skip a phase silently — the runner needs each
    // work-entered to load the right round into the cue engine.
    const h = harness()
    h.session.start()
    // 10s work + 5s rest per round, so 31s lands 1s into round 3's work.
    h.clock.advance(31_000)
    expect(types(h.session.advance())).toEqual([
      'rest-entered',
      'work-entered',
      'rest-entered',
      'work-entered',
    ])
    expect(h.session.snapshot().roundIndex).toBe(2)
    expect(h.session.snapshot().workElapsedMs).toBe(1_000)

    // The last round has no rest, so finishing it ends the session.
    h.clock.advance(9_100)
    expect(types(h.session.advance())).toEqual(['completed'])
  })

  it('carries overflow into the next phase rather than discarding it', () => {
    const h = harness()
    h.session.start()
    h.clock.advance(10_250)
    h.session.advance()
    // 250ms past the bell belongs to the rest that just began.
    expect(h.session.snapshot().phase).toBe('rest')
    expect(h.session.snapshot().phaseElapsedMs).toBe(250)
  })

  it('skips a zero-length rest between rounds', () => {
    const h = harness([
      { workDurationMs: 1_000, restAfterMs: 0 },
      { workDurationMs: 1_000, restAfterMs: 0 },
    ])
    h.session.start()
    h.clock.advance(1_100)
    expect(types(h.session.advance())).toEqual(['work-entered'])
    expect(h.session.snapshot().roundIndex).toBe(1)
  })
})

describe('the work clock', () => {
  it('tracks elapsed time inside the work interval', () => {
    const h = harness()
    h.session.start()
    h.run(4_000)
    expect(h.session.snapshot().workElapsedMs).toBe(4_000)
  })

  it('resets at the start of each round', () => {
    const h = harness()
    h.session.start()
    h.run(15_100) // through round 1's work and rest
    expect(h.session.snapshot().phase).toBe('work')
    expect(h.session.snapshot().workElapsedMs).toBeLessThan(1_000)
  })

  it('freezes across a pause and does not shift the round', () => {
    // This is the property the CueEngine depends on: it schedules against
    // workElapsedMs and does no pause arithmetic of its own.
    const h = harness()
    h.session.start()
    h.run(4_000)
    const frozen = h.session.snapshot().workElapsedMs

    h.session.pause()
    h.run(30_000) // half a minute of wall time while paused
    expect(h.session.snapshot().workElapsedMs).toBe(frozen)
    expect(h.session.snapshot().phase).toBe('paused')

    h.session.resume()
    h.run(1_000)
    expect(h.session.snapshot().workElapsedMs).toBe(frozen + 1_000)
    // Still round 0: the pause consumed none of the round.
    expect(h.session.snapshot().roundIndex).toBe(0)
    expect(h.session.snapshot().phase).toBe('work')
  })

  it('survives repeated pause/resume without drift', () => {
    const h = harness()
    h.session.start()
    for (let i = 0; i < 5; i++) {
      h.run(1_000)
      h.session.pause()
      h.run(3_000)
      h.session.resume()
    }
    expect(h.session.snapshot().workElapsedMs).toBe(5_000)
  })
})

describe('pause and resume', () => {
  it('restores the phase it was in', () => {
    const h = harness()
    h.session.start()
    h.run(10_100)
    expect(h.session.snapshot().phase).toBe('rest')

    h.session.pause()
    h.session.resume()
    expect(h.session.snapshot().phase).toBe('rest')
  })

  it('ignores a pause when not running and a resume when not paused', () => {
    const h = harness()
    expect(h.session.pause()).toEqual([])
    h.session.start()
    expect(h.session.resume()).toEqual([])
  })
})

describe('a pause between two ticks', () => {
  // A tick comes every 50 ms on a device, and a pause is a tap: it lands
  // between two of them. Every pause test above pauses ON a tick, where the
  // time since the last tick is nothing — which is how a pause that dropped
  // that time went unseen. It is the mirror of the round that opened a tick
  // early (findings doc, N-18).
  const SINCE_LAST_TICK_MS = 30

  it('counts the time up to the pause', () => {
    const h = harness()
    h.session.start()
    h.run(3_000)
    h.clock.advance(SINCE_LAST_TICK_MS)
    h.session.pause()
    expect(h.session.snapshot().workElapsedMs).toBe(3_030)

    h.clock.advance(30_000)
    h.session.resume()
    h.run(1_000)
    // 4,030 ms of the round have been worked, and the clock says so.
    expect(h.session.snapshot().workElapsedMs).toBe(4_030)
  })

  it('loses nothing over many pauses', () => {
    const h = harness()
    h.session.start()
    for (let i = 0; i < 5; i++) {
      h.run(1_000)
      h.clock.advance(SINCE_LAST_TICK_MS)
      h.session.pause()
      h.clock.advance(3_000)
      h.session.resume()
    }
    // It read 5,000: 150 ms of work the round then ran over by.
    expect(h.session.snapshot().workElapsedMs).toBe(5_150)
  })

  it('reads the same frozen time at any instant while paused', () => {
    const h = harness()
    h.session.start()
    h.run(3_000)
    h.clock.advance(SINCE_LAST_TICK_MS)
    h.session.pause()
    h.clock.advance(10_000)
    expect(h.session.workElapsedAt(h.clock.now())).toBe(3_030)
  })

  it('counts it in a countdown and in a rest too', () => {
    const h = harness(ROUNDS, 3_000)
    h.session.start()
    h.run(1_000)
    h.clock.advance(SINCE_LAST_TICK_MS)
    h.session.pause()
    expect(h.session.snapshot().phaseElapsedMs).toBe(1_030)
    h.session.resume()
    h.run(2_000 + 10_000 + 1_000) // the countdown's end, round 1, a second of rest
    expect(h.session.snapshot().phase).toBe('rest')
    const before = h.session.snapshot().phaseElapsedMs
    h.clock.advance(SINCE_LAST_TICK_MS)
    h.session.pause()
    expect(h.session.snapshot().phaseElapsedMs).toBe(before + SINCE_LAST_TICK_MS)
  })

  it('enters the rest, then pauses, when the round ended since the last tick', () => {
    const h = harness()
    h.session.start()
    h.run(9_900)
    // 130 ms on: 30 ms past the bell, and no tick has seen it yet.
    h.clock.advance(130)
    expect(h.session.pause()).toEqual([{ type: 'rest-entered', roundIndex: 0 }, { type: 'paused' }])
    expect(h.session.snapshot()).toMatchObject({ phase: 'paused', roundIndex: 0 })

    h.clock.advance(60_000)
    expect(h.session.resume()).toEqual([{ type: 'resumed' }])
    // The rest is the 30 ms old it was when the pause landed.
    expect(h.session.snapshot()).toMatchObject({ phase: 'rest', phaseElapsedMs: 30 })
  })

  it('completes the workout instead when the last round ended since the last tick', () => {
    const h = harness([{ workDurationMs: 1_000, restAfterMs: 0 }])
    h.session.start()
    h.run(900)
    h.clock.advance(130)
    expect(h.session.pause()).toEqual([{ type: 'completed' }])
    expect(h.session.snapshot().phase).toBe('completed')
    // There is nothing to resume.
    expect(h.session.resume()).toEqual([])
  })
})
describe('cancel (doc §25)', () => {
  it('stops immediately and accumulates nothing further', () => {
    const h = harness()
    h.session.start()
    h.run(3_000)
    expect(h.session.cancel()).toEqual([{ type: 'cancelled' }])

    h.run(30_000)
    expect(h.session.snapshot().phase).toBe('cancelled')
    expect(types(h.seen)).not.toContain('completed')
  })

  it('is idempotent', () => {
    const h = harness()
    h.session.start()
    h.session.cancel()
    expect(h.session.cancel()).toEqual([])
  })
})

describe('snapshot', () => {
  it('reports remaining time in the current phase, floored at zero', () => {
    const h = harness()
    h.session.start()
    h.run(3_000)
    expect(h.session.snapshot().phaseRemainingMs).toBe(7_000)
  })

  it('reports the round count', () => {
    const h = harness()
    expect(h.session.snapshot().roundCount).toBe(3)
  })

  it('starts idle with no round', () => {
    const h = harness()
    expect(h.session.snapshot().phase).toBe('idle')
    expect(h.session.snapshot().roundIndex).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// workElapsedAt — the one conversion between the monotonic and work clocks
// ---------------------------------------------------------------------------

/**
 * Every case runs at four clock origins.
 *
 * The origin stands in for the device's uptime when the app launched. It is
 * arbitrary by contract (`MonotonicClock.now()` is "milliseconds from an
 * arbitrary origin"), and it is exactly what a suite pinned to origin 0 can
 * never see: at 0 the monotonic clock and the first round's work clock are
 * the same number line, so code that confuses the two passes every test and
 * is wrong on every device.
 */
describe.each([0, 1_000, 3_600_000, 86_400_000])(
  'workElapsedAt with the clock starting at %i ms',
  (originMs) => {
    function at(countdownMs = 0) {
      const clock: FakeClock = createFakeClock(originMs)
      const session = new WorkoutSessionClock(ROUNDS, { clock, countdownMs })
      const run = (ms: number, stepMs = 100): void => {
        for (let i = 0; i < Math.ceil(ms / stepMs); i++) {
          clock.advance(stepMs)
          session.advance()
        }
      }
      return { clock, session, run }
    }

    it('reads zero before the workout starts', () => {
      const h = at()
      expect(h.session.workElapsedAt(h.clock.now())).toBe(0)
    })

    it('reads the work clock at the instant of the last advance', () => {
      const h = at()
      h.session.start()
      h.run(2_500)
      expect(h.session.workElapsedAt(h.clock.now())).toBe(2_500)
      expect(h.session.workElapsedAt(h.clock.now())).toBe(h.session.snapshot().workElapsedMs)
    })

    it('places an instant that falls between two ticks', () => {
      // A punch lands 37 ms after the last tick and is handled before the
      // next one — the usual case, since the tick is 50 ms and a punch is not
      // synchronised to it.
      const h = at()
      h.session.start()
      h.run(2_000)
      expect(h.session.workElapsedAt(asMonotonicMs(h.clock.now() + 37))).toBe(2_037)
    })

    it('places an instant stamped just before the tick that preceded it', () => {
      const h = at()
      h.session.start()
      h.run(2_000)
      expect(h.session.workElapsedAt(asMonotonicMs(h.clock.now() - 12))).toBe(1_988)
    })

    it('is frozen for as long as the session is paused', () => {
      const h = at()
      h.session.start()
      h.run(3_000)
      h.session.pause()
      h.run(60_000)
      expect(h.session.workElapsedAt(h.clock.now())).toBe(3_000)
      // Even an instant "in the future" reads the frozen value: the work
      // clock is not running, so there is nothing to project.
      expect(h.session.workElapsedAt(asMonotonicMs(h.clock.now() + 500))).toBe(3_000)

      h.session.resume()
      h.run(500)
      expect(h.session.workElapsedAt(h.clock.now())).toBe(3_500)
    })

    it('restarts from zero in the next round', () => {
      const h = at()
      h.session.start()
      h.run(10_000 + 5_000 + 1_200)
      expect(h.session.snapshot().roundIndex).toBe(1)
      expect(h.session.workElapsedAt(h.clock.now())).toBe(1_200)
    })

    it('holds the last work reading through a rest', () => {
      const h = at()
      h.session.start()
      h.run(10_000 + 2_000)
      expect(h.session.snapshot().phase).toBe('rest')
      expect(h.session.workElapsedAt(h.clock.now())).toBe(h.session.snapshot().workElapsedMs)
      expect(h.session.workElapsedAt(asMonotonicMs(h.clock.now() + 900))).toBe(
        h.session.snapshot().workElapsedMs,
      )
    })

    it('carries a countdown overflow into the round it opens', () => {
      // 700 ms steps cross a 3 000 ms countdown at 3 500: the round is
      // already 500 ms old when it is entered.
      const h = at(3_000)
      h.session.start()
      h.run(3_500, 700)
      expect(h.session.snapshot().phase).toBe('work')
      expect(h.session.workElapsedAt(h.clock.now())).toBe(500)
    })

    it('opens the round at zero when the countdown is skipped', () => {
      const h = at(3_000)
      h.session.start()
      h.run(1_000)
      h.session.skipCountdown()
      expect(h.session.snapshot().phase).toBe('work')
      expect(h.session.workElapsedAt(h.clock.now())).toBe(0)
      expect(h.session.workElapsedAt(asMonotonicMs(h.clock.now() + 40))).toBe(40)
    })

    it('opens the next round at zero when the rest is skipped', () => {
      const h = at()
      h.session.start()
      h.run(10_000 + 1_000)
      h.session.skipRest()
      expect(h.session.snapshot().roundIndex).toBe(1)
      expect(h.session.workElapsedAt(h.clock.now())).toBe(0)
    })

    it('opens the round at the skip, not at the tick before it', () => {
      // The intro does not end on a tick. The 30 ms since the last one was
      // lead-in; none of it is work. Counting it put the work clock — which
      // schedules the calls and scores the punches — ahead of the bell for
      // the whole round.
      const h = at(3_000)
      h.session.start()
      h.run(1_000)
      h.clock.advance(30)
      h.session.skipCountdown()
      expect(h.session.workElapsedAt(h.clock.now())).toBe(0)

      h.clock.advance(20)
      h.session.advance()
      expect(h.session.snapshot().workElapsedMs).toBe(20)
      expect(h.session.workElapsedAt(h.clock.now())).toBe(20)
    })

    it('opens the next round at the skip of a rest, not at the tick before it', () => {
      const h = at()
      h.session.start()
      h.run(10_000 + 1_000)
      h.clock.advance(30)
      h.session.skipRest()
      expect(h.session.snapshot().roundIndex).toBe(1)
      expect(h.session.workElapsedAt(h.clock.now())).toBe(0)

      h.clock.advance(20)
      h.session.advance()
      expect(h.session.snapshot().workElapsedMs).toBe(20)
      expect(h.session.workElapsedAt(h.clock.now())).toBe(20)
    })

    it('gives a round opened by a skip its whole length', () => {
      // The same head start, seen from the other end: the round would close
      // that much before its time.
      const h = at(3_000)
      h.session.start()
      h.run(1_000)
      h.clock.advance(30)
      h.session.skipCountdown()

      h.clock.advance(9_999)
      h.session.advance()
      expect(h.session.snapshot().phase).toBe('work')
      expect(h.session.snapshot().phaseRemainingMs).toBe(1)

      h.clock.advance(1)
      h.session.advance()
      expect(h.session.snapshot().phase).toBe('rest')
    })

    it('ends the session, and nothing else, when the last rest is skipped between ticks', () => {
      const h = at()
      const lastRest: SessionRoundSpec[] = [{ workDurationMs: 1_000, restAfterMs: 5_000 }]
      const session = new WorkoutSessionClock(lastRest, { clock: h.clock, countdownMs: 0 })
      session.start()
      h.clock.advance(1_000)
      session.advance()
      expect(session.snapshot().phase).toBe('rest')
      h.clock.advance(30)
      expect(session.skipRest().map((t) => t.type)).toEqual(['completed'])
      expect(session.workElapsedAt(asMonotonicMs(h.clock.now() + 500))).toBe(1_000)
    })

    it('agrees with the ring projection, so scoring and the rings share one rule', () => {
      // `SharedWorkClock` is the UI thread's copy of this clock. The two are
      // written separately (one is a worklet), so this pins them together.
      const h = at()
      h.session.start()
      h.run(2_000)
      const snapshot = h.session.snapshot()
      const shared: SharedWorkClock = {
        roundIndex: snapshot.roundIndex,
        workElapsedAtPublishMs: snapshot.workElapsedMs,
        publishFrameTimestampMs: h.clock.now(),
        running: snapshot.phase === 'work',
      }
      for (const deltaMs of [-20, 0, 17, 250]) {
        const instant = h.clock.now() + deltaMs
        expect(h.session.workElapsedAt(asMonotonicMs(instant))).toBe(
          sharedWorkElapsedMs(shared, instant),
        )
      }
    })
  },
)
