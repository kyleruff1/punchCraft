/**
 * A round's clocks open at one instant (findings doc, N-18).
 *
 * Three things have to agree about when a round began: the bell, the work
 * clock — which schedules the calls and the ring tokens and scores the
 * punches — and the UI-thread ring clock the rings are painted from. They
 * did not. A round opened by a skip (round 1 always is: the intro ends ahead
 * of the lead-in's cap) kept the work clock's anchor at the tick BEFORE the
 * skip, so that clock ran up to a tick ahead of the bell for the whole round.
 *
 * Nothing saw it, because every test that skipped did so on a tick, where
 * "now" and "the last tick" are the same instant. Here the skip lands
 * between two ticks, as it does on a device, and sending the bell costs time,
 * as it does on a device.
 *
 * The first figure checked is the one the tablet's timing tool prints for
 * every round — a ring token's monotonic stamp minus its work-clock reading,
 * which is where that round's work clock has its zero.
 */
import React, { useImperativeHandle } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { View } from 'react-native'

import { useWorkoutRunner, TICK_INTERVAL_MS, type WorkoutRunner } from '../_useWorkoutRunner'
import { createFakeClock, type FakeClock } from '@testing/fakeClock'
import { defaultRecipe } from '@domain/workout/WorkoutRecipe'
import { defaultVoiceCoachPolicy } from '@domain/coach/VoiceCoachPolicy'
import { StaticPlaybackDetector } from '@audio/ThirdPartyPlaybackDetector'
import { SHARED_WORK_CLOCK_STOPPED, type SharedWorkClock } from '@domain/timing/SharedWorkClock'
import { getLive, resetLive, useLiveStore } from '@state/useWorkoutStore'
import { replaceSinks } from '@diagnostics/logger'
import type { VoiceAssetId, VoiceOutputPort } from '@domain/coach/VoiceOutputPort'
import type { GeneratedWorkout } from '@domain/workout/GeneratedWorkout'
import type { PunchEventSource } from '@domain/punch/PunchEventSource'
import type { ProgramRound } from '@domain/workout/WorkoutTokens'

const WORK_MS = 4_000
const REST_MS = 2_000
const COUNTDOWN_MS = 1_000
/** Not a multiple of the tick: the skip must land between two of them. */
const SINCE_LAST_TICK_MS = 30

function round(order: number, isLast: boolean): ProgramRound {
  return {
    id: `r${order}`,
    order,
    kind: 'round',
    countsTowardGoal: true,
    theme: `Round ${order}`,
    workDurationMs: WORK_MS,
    restAfterMs: isLast ? 0 : REST_MS,
    targetPunches: 4,
    blocks: [
      {
        id: `r${order}-b1`,
        kind: 'repeated-combo',
        stance: 'inherit',
        // Clear of the tick that opens the round, so no ring is logged in the
        // same tick as the bell.
        startOffsetMs: 500,
        durationMs: 1_000,
        gapBeats: 1,
        repeat: 2,
        tokens: [
          { kind: 'punch', number: 1, body: false, beatOffset: 0 },
          { kind: 'punch', number: 2, body: false, beatOffset: 0.6 },
        ],
      },
    ],
  }
}

const WORKOUT: GeneratedWorkout = {
  id: 'round-opening-fixture',
  recipe: defaultRecipe(),
  schedule: [round(1, false), round(2, true)],
  roundPunchTargets: [4, 4],
  expectedTechniqueDistribution: {},
  estimatedActivePunchesPerMinute: 60,
  warnings: [],
}

class SilentSource implements PunchEventSource {
  readonly id = 'silent'
  readonly capability = { hand: true, timestamp: true, punchType: 'none' as const, velocity: true }
  subscribe(): () => void {
    return () => {}
  }
  start(): void {}
  stop(): void {}
}

/** A voice output on which sending the bell takes time, as it does on a device. */
class TimedBell implements VoiceOutputPort {
  constructor(
    private readonly clock: FakeClock,
    private readonly bellCostMs: number,
  ) {}
  playAsset(id: VoiceAssetId): void {
    if (id === 'bell' && this.bellCostMs > 0) this.clock.advance(this.bellCostMs)
  }
  speak(): void {}
  tone(): void {}
  cancel(): void {}
  playClickScript(): void {}
  setVolumes(): void {}
}

/** One ring token, as the runner logged it, with the ring clock as it stood then. */
interface Ring {
  roundIndex: number
  workElapsedMs: number
  monotonicTimeMs: number
  ringClock: SharedWorkClock
}

interface Harness {
  runner: WorkoutRunner
  clock: FakeClock
  /** Every ring token fired so far, in order. */
  rings: Ring[]
  /** Run `n` whole ticks: the clock and the interval timer together. */
  tick(n?: number): void
  /** Let time pass with no tick — where a skip really lands. */
  drift(ms: number): void
  start(): void
  unmount(): void
}

async function mount(bellCostMs = 0): Promise<Harness> {
  const clock = createFakeClock()
  const slot: { value: SharedWorkClock } = { value: SHARED_WORK_CLOCK_STOPPED }
  const rings: Ring[] = []
  const ref = React.createRef<WorkoutRunner>()
  const voice = {
    output: new TimedBell(clock, bellCostMs),
    policy: defaultVoiceCoachPolicy(),
    detector: new StaticPlaybackDetector(false),
  }
  // On a device the runner's clock and the frame stamp are both
  // `performance.now()`. Here the runner's clock is the fake one, so the
  // frame stamp reads it too.
  jest.spyOn(performance, 'now').mockImplementation(() => clock.now())
  replaceSinks([
    {
      write: (record) => {
        if (record.code !== 'workout.cue.tokenDue') return
        rings.push({
          roundIndex: record.fields.roundIndex?.value as number,
          workElapsedMs: record.fields.workElapsedMs?.value as number,
          monotonicTimeMs: record.fields.monotonicTimeMs?.value as number,
          ringClock: slot.value,
        })
      },
    },
  ])

  function Probe(): React.JSX.Element {
    const runner = useWorkoutRunner({
      workout: WORKOUT,
      source: new SilentSource(),
      stance: 'orthodox',
      clock,
      countdownMs: COUNTDOWN_MS,
      persistence: null,
      voice,
      workClock: slot,
    })
    useImperativeHandle(ref, () => runner, [runner])
    return <View />
  }

  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<Probe />)
  })
  // The voice gate opens on the detector's first answer — a microtask.
  await act(async () => {
    await Promise.resolve()
  })

  return {
    get runner() {
      return ref.current as WorkoutRunner
    },
    clock,
    rings,
    tick: (n = 1) => {
      act(() => {
        for (let i = 0; i < n; i++) {
          clock.advance(TICK_INTERVAL_MS)
          jest.advanceTimersByTime(TICK_INTERVAL_MS)
        }
      })
    },
    drift: (ms) => {
      act(() => {
        clock.advance(ms)
      })
    },
    start: () => {
      act(() => {
        ;(ref.current as WorkoutRunner).start()
      })
    },
    unmount: () => {
      act(() => {
        tree.unmount()
      })
    },
  }
}

const ticksIn = (ms: number): number => Math.ceil(ms / TICK_INTERVAL_MS)

/** Where a round's work clock has its zero, by each ring token fired in it. */
const workZeros = (h: Harness, roundIndex: number): number[] =>
  h.rings.filter((r) => r.roundIndex === roundIndex).map((r) => r.monotonicTimeMs - r.workElapsedMs)

beforeEach(() => {
  jest.useFakeTimers()
  resetLive()
})

afterEach(() => {
  replaceSinks([])
  jest.restoreAllMocks()
  jest.useRealTimers()
  act(() => {
    useLiveStore.getState().resetLive()
  })
})

// ---------------------------------------------------------------------------

describe('the work clock of a round opened between two ticks', () => {
  it('starts at the moment the intro ends, not at the tick before it', async () => {
    const h = await mount()
    h.start()
    h.tick(4)
    h.drift(SINCE_LAST_TICK_MS)
    const opened = h.clock.now()
    act(() => {
      h.runner.skipCountdown()
    })
    expect(getLive().phase).toBe('work')
    h.tick(ticksIn(WORK_MS) - 2)

    const zeros = workZeros(h, 0)
    expect(zeros.length).toBeGreaterThan(0)
    expect(new Set(zeros)).toEqual(new Set([opened]))
    h.unmount()
  })

  it('starts at the moment a rest is skipped, not at the tick before it', async () => {
    const h = await mount()
    h.start()
    h.tick(ticksIn(COUNTDOWN_MS) + ticksIn(WORK_MS) + 2)
    expect(getLive().phase).toBe('rest')
    h.drift(SINCE_LAST_TICK_MS)
    const opened = h.clock.now()
    act(() => {
      h.runner.skipRest()
    })
    expect(getLive().roundIndex).toBe(1)
    h.tick(ticksIn(WORK_MS) - 2)

    const zeros = workZeros(h, 1)
    expect(zeros.length).toBeGreaterThan(0)
    expect(new Set(zeros)).toEqual(new Set([opened]))
    h.unmount()
  })

  it('still starts on the tick when the lead-in runs out by itself', async () => {
    const h = await mount()
    h.start()
    h.tick(ticksIn(COUNTDOWN_MS))
    const opened = h.clock.now()
    expect(getLive().phase).toBe('work')
    h.tick(ticksIn(WORK_MS) - 2)

    expect(new Set(workZeros(h, 0))).toEqual(new Set([opened]))
    h.unmount()
  })
})
