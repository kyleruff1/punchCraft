/**
 * A pause lands between two ticks.
 *
 * The runner ticks every 50 ms and a pause is a tap, so the session clock is
 * up to a tick behind when it arrives. Every other suite pauses ON a tick,
 * where there is nothing behind to count — which is how a pause that dropped
 * that time, and a header that read 0:00 for as long as the pause lasted,
 * both went unseen. Same shape as the round that opened a tick early (N-18):
 * here the tap lands between two ticks, as it does on a device.
 */
import React, { useImperativeHandle } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { View } from 'react-native'

import { HeaderRoundClock } from '../../_layout'
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
/** Not a multiple of the tick: the tap must land between two of them. */
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
  id: 'pause-between-ticks-fixture',
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

/** A voice output that only counts the bells it was asked for. */
class CountingBells implements VoiceOutputPort {
  bells = 0
  playAsset(id: VoiceAssetId): void {
    if (id === 'bell') this.bells += 1
  }
  speak(): void {}
  tone(): void {}
  cancel(): void {}
  playClickScript(): void {}
  setVolumes(): void {}
}

interface Harness {
  runner: WorkoutRunner
  clock: FakeClock
  output: CountingBells
  /** Every `workout.round.boundary` logged so far, as `transition@roundIndex`. */
  boundaries: string[]
  ringClock(): SharedWorkClock
  tick(n?: number): void
  drift(ms: number): void
  do(action: (runner: WorkoutRunner) => void): void
  unmount(): void
}

async function mount(): Promise<Harness> {
  const clock = createFakeClock()
  const slot: { value: SharedWorkClock } = { value: SHARED_WORK_CLOCK_STOPPED }
  const boundaries: string[] = []
  const ref = React.createRef<WorkoutRunner>()
  const output = new CountingBells()
  const voice = {
    output,
    policy: defaultVoiceCoachPolicy(),
    detector: new StaticPlaybackDetector(false),
  }
  jest.spyOn(performance, 'now').mockImplementation(() => clock.now())
  replaceSinks([
    {
      write: (record) => {
        if (record.code !== 'workout.round.boundary') return
        boundaries.push(
          `${String(record.fields.transition?.value)}@${String(record.fields.roundIndex?.value)}`,
        )
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
    output,
    boundaries,
    ringClock: () => slot.value,
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
    do: (action) => {
      act(() => {
        action(ref.current as WorkoutRunner)
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

/** Start, and run to `intoRoundMs` of round 1's work, on a tick. */
async function inRoundOne(intoRoundMs: number): Promise<Harness> {
  const h = await mount()
  h.do((runner) => runner.start())
  h.tick(ticksIn(COUNTDOWN_MS) + ticksIn(intoRoundMs))
  expect(getLive()).toMatchObject({ phase: 'work', roundIndex: 0 })
  return h
}

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

describe('a pause between two ticks', () => {
  it('counts the time up to the pause, and the round ends when it has been worked', async () => {
    const h = await inRoundOne(1_000)
    h.drift(SINCE_LAST_TICK_MS)
    h.do((runner) => runner.pause())
    expect(getLive().phase).toBe('paused')
    // The ring clock is published stopped, at the instant of the tap.
    expect(h.ringClock()).toMatchObject({ running: false, workElapsedAtPublishMs: 1_030 })

    h.drift(20_000)
    h.do((runner) => runner.resume())
    // 2,970 ms of the round are left: it ends inside the 60th tick from here,
    // not the 61st — the 30 ms were worked, and are not worked again.
    h.tick(59)
    expect(getLive().phase).toBe('work')
    h.tick(1)
    expect(getLive().phase).toBe('rest')
    h.unmount()
  })

  it('rings the bell and enters the rest, then pauses, when the round ended since the last tick', async () => {
    const h = await inRoundOne(WORK_MS - TICK_INTERVAL_MS)
    const bells = h.output.bells
    // 80 ms on: 30 ms past the end of the round, and no tick has seen it.
    h.drift(TICK_INTERVAL_MS + SINCE_LAST_TICK_MS)
    h.do((runner) => runner.pause())

    expect(h.boundaries.slice(-2)).toEqual(['rest-entered@0', 'paused@0'])
    expect(h.output.bells).toBe(bells + 1)
    expect(getLive()).toMatchObject({ phase: 'paused', roundIndex: 0 })

    h.drift(20_000)
    h.do((runner) => runner.resume())
    expect(getLive()).toMatchObject({ phase: 'rest', roundIndex: 0 })
    // The rest was 30 ms old when the pause landed, and runs its full length.
    h.tick(ticksIn(REST_MS) - 1)
    expect(getLive().phase).toBe('rest')
    h.tick(1)
    expect(getLive()).toMatchObject({ phase: 'work', roundIndex: 1 })
    h.unmount()
  })
})

describe('the header while paused', () => {
  /** What the header prints for the time left: the tabs header, as rendered. */
  const headerClock = (): string => {
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<HeaderRoundClock />)
    })
    const text = tree.root.findByProps({ testID: 'round-countdown' }).props.children as string
    act(() => {
      tree.unmount()
    })
    return text
  }

  it('shows the time left in the round, not 0:00', async () => {
    const h = await inRoundOne(1_000)
    expect(headerClock()).toBe('0:03')
    h.do((runner) => runner.pause())
    expect(getLive().phase).toBe('paused')
    // It read 0:00 for as long as the pause lasted: a paused session has no
    // phase of its own to be part-way through, and "none" was shown as zero.
    expect(headerClock()).toBe('0:03')
    h.drift(45_000)
    h.tick(3)
    expect(headerClock()).toBe('0:03')

    h.do((runner) => runner.resume())
    h.tick(ticksIn(1_000))
    expect(headerClock()).toBe('0:02')
    h.unmount()
  })

  it('shows the time left in a rest and in the countdown too', async () => {
    const h = await mount()
    h.do((runner) => runner.start())
    h.tick(ticksIn(400))
    h.do((runner) => runner.pause())
    expect(headerClock()).toBe('0:01')
    h.do((runner) => runner.resume())
    h.tick(ticksIn(COUNTDOWN_MS - 400) + ticksIn(WORK_MS) + ticksIn(500))
    expect(getLive().phase).toBe('rest')
    h.do((runner) => runner.pause())
    expect(headerClock()).toBe('0:02')
    h.unmount()
  })
})
