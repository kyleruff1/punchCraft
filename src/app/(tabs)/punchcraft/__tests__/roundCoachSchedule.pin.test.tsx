/**
 * What the runner dispatches in a round — pinned.
 *
 * The rule that turns a round's bars into its calls and lead-ins (which bar
 * is called, with which clip, at what moment; which calls give way to a
 * lead-in) lived inside the runner hook. It is being lifted into a domain
 * function so that the verifier's manifest can be that function's output
 * and not a second copy of the rule — a copy that had already drifted: it
 * kept a 100 ms pad where the runner has used 500 since September, and in 20
 * of 44 whole-workout runs the runner dispatched more calls than the copy
 * expected (findings doc, N-20).
 *
 * This is the before-and-after. It drives real sample workouts through the
 * real runner with a recording voice port and writes down, for rounds 1 and
 * 2, every call and lead-in in the order sent, each as `slot#dispatchAtMs`
 * — the trace id the runner itself gives a dispatch. It was written against
 * the hook as it stood and must not change when the rule moves.
 *
 * The port is never busy, so what is recorded is the schedule itself: every
 * entry goes out on the first tick at or after its time.
 */
import React, { useImperativeHandle } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { View } from 'react-native'

import { useWorkoutRunner, TICK_INTERVAL_MS, type WorkoutRunner } from '../_useWorkoutRunner'
import { StaticPlaybackDetector } from '@audio/ThirdPartyPlaybackDetector'
import { defaultVoiceCoachPolicy } from '@domain/coach/VoiceCoachPolicy'
import type { VoiceOutputPort } from '@domain/coach/VoiceOutputPort'
import type { PunchEventSource } from '@domain/punch/PunchEventSource'
import { getSampleWorkout, type SampleWorkoutKey } from '@domain/workout/samples'
import { getLive, resetLive, useLiveStore } from '@state/useWorkoutStore'
import { createFakeClock } from '@testing/fakeClock'

class SilentSource implements PunchEventSource {
  readonly id = 'silent'
  readonly capability = { hand: true, timestamp: true, punchType: 'none' as const, velocity: true }
  subscribe(): () => void {
    return () => {}
  }
  start(): void {}
  stop(): void {}
}

/** Records each click-script dispatch under the round it was sent in. */
class RecordingPort implements VoiceOutputPort {
  readonly byRound = new Map<number, string[]>()
  playAsset(): void {}
  speak(): void {}
  tone(): void {}
  cancel(): void {}
  setVolumes(): void {}
  playClickScript(clip: { text: string; traceId?: string }): void {
    const live = getLive()
    // Only a round's own dispatches: nothing here is sent during a rest.
    const round = live.phase === 'work' ? live.roundIndex : -1
    this.byRound.set(round, [...(this.byRound.get(round) ?? []), clip.traceId ?? clip.text])
  }
}

async function dispatched(
  key: SampleWorkoutKey,
  vocabulary: 'numbers' | 'names',
): Promise<{ 'round 1': string[]; 'round 2': string[]; 'outside a round': string[] }> {
  const { workout } = getSampleWorkout(key)
  const clock = createFakeClock()
  const port = new RecordingPort()
  const ref = React.createRef<WorkoutRunner>()
  const voice = {
    output: port,
    policy: { ...defaultVoiceCoachPolicy(), mode: 'standard' as const, vocabulary },
    detector: new StaticPlaybackDetector(false),
  }

  function Probe(): React.JSX.Element {
    const runner = useWorkoutRunner({
      workout,
      source: new SilentSource(),
      stance: 'orthodox',
      clock,
      persistence: null,
      voice,
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
  act(() => {
    ;(ref.current as WorkoutRunner).start()
  })
  // Through the lead-in, round 1, its rest, and round 2.
  const [first, second] = workout.schedule
  const runMs =
    10_000 + first!.workDurationMs + first!.restAfterMs + (second?.workDurationMs ?? 0) + 1_000
  act(() => {
    for (let elapsed = 0; elapsed < runMs; elapsed += TICK_INTERVAL_MS) {
      clock.advance(TICK_INTERVAL_MS)
      jest.advanceTimersByTime(TICK_INTERVAL_MS)
    }
  })
  act(() => {
    tree.unmount()
  })
  return {
    'round 1': port.byRound.get(0) ?? [],
    'round 2': port.byRound.get(1) ?? [],
    'outside a round': port.byRound.get(-1) ?? [],
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  resetLive()
})

afterEach(() => {
  jest.useRealTimers()
  act(() => {
    useLiveStore.getState().resetLive()
  })
})

describe('what the runner dispatches in rounds 1 and 2', () => {
  it.each([
    ['quick-one-two', 'numbers'],
    ['body-work', 'names'],
    ['three-round-fundamentals', 'numbers'],
  ] as const)('%s, %s', async (key, vocabulary) => {
    const sent = await dispatched(key, vocabulary)
    // Something was sent in both rounds, and nothing outside one.
    expect(sent['round 1'].length).toBeGreaterThan(10)
    expect(sent['round 2'].length).toBeGreaterThan(10)
    expect(sent['outside a round']).toEqual([])
    expect(sent).toMatchSnapshot()
  })
})
