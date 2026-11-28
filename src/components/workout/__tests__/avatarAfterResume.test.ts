/**
 * Found, not fixed (findings doc, §3j): after a resume the avatar holds a
 * strike pose until the next punch.
 *
 * THIS PINS TODAY'S BEHAVIOUR. It does not say the behaviour is wanted.
 *
 * The avatar's pose is a function of how long ago its punch began, measured
 * in transport ticks: the tick now, less the tick sampled when the punch was
 * adopted. A pause stops the transport and a resume starts a NEW one at tick
 * 0 (`MetronomeTransport.start`: "Absolute tick resets to 0"). The sampled
 * tick is from the old transport and is not resampled, so "now less then" is
 * negative — by however many ticks of the round had passed.
 *
 * The pose function clamps a negative age to zero, and at zero the pose is
 * the strike. So the avatar shows the strike — or, for a repeated punch, its
 * retract — until either the next punch is adopted and resamples, or the new
 * transport counts back up to the old tick, which takes as long as the round
 * had already run.
 *
 * Both halves are pure and are pinned here; the hook that joins them
 * (`useAvatarFrameClock`) is a worklet and is not run.
 */
// Reanimated needs a native binding this workstation does not have. The
// helpers under test never touch it; a stub of the imported names lets the
// module load.
jest.mock('react-native-reanimated', () => ({
  runOnJS:
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) =>
      fn(...args),
  useSharedValue: <T>(init: T) => ({ value: init }),
  useFrameCallback: () => ({ setActive: () => {} }),
}))
import {
  sharedAnchorCurrentTick,
  type SharedTransportAnchor,
} from '@domain/timing/SharedTransportAnchor'

import { avatarFrameAtWorklet } from '../useAvatarFrameClock'

const TICKS_PER_MS = 0.96 // 120 bpm
const anchor = (over: Partial<SharedTransportAnchor>): SharedTransportAnchor =>
  ({
    running: true,
    generation: 1,
    anchorTick: 0,
    anchorFrameTimestampMs: 0,
    ticksPerMillisecond: TICKS_PER_MS,
    ...over,
  }) as SharedTransportAnchor

describe('found, not fixed: the avatar after a resume', () => {
  // A punch adopted 60 s into the round, with a 500 ms window.
  const WINDOW_MS = 500
  const adoptedAtMs = 60_000
  const before = anchor({})
  const startedAtTick = sharedAnchorCurrentTick(before, adoptedAtMs)

  it('runs its cycle while the transport that adopted it keeps running', () => {
    const ageAt = (frameMs: number): number =>
      (sharedAnchorCurrentTick(before, frameMs) - startedAtTick) / TICKS_PER_MS
    expect(avatarFrameAtWorklet(ageAt(adoptedAtMs + 100), WINDOW_MS, false)).toBe('step1')
    expect(avatarFrameAtWorklet(ageAt(adoptedAtMs + 2_000), WINDOW_MS, false)).toBe('guard')
  })

  it('reads a negative age once a resume has restarted the transport at tick 0', () => {
    // Paused at 60.2 s, resumed half a minute later: a new transport, from 0.
    const resumedAtMs = 90_200
    const after = anchor({ generation: 2, anchorTick: 0, anchorFrameTimestampMs: resumedAtMs })
    const ageAt = (frameMs: number): number =>
      (sharedAnchorCurrentTick(after, frameMs) - startedAtTick) / TICKS_PER_MS
    expect(ageAt(resumedAtMs + 1_000)).toBeCloseTo(-59_000, 0)
    // Negative is clamped to "just begun": the strike, held…
    expect(avatarFrameAtWorklet(ageAt(resumedAtMs + 1_000), WINDOW_MS, false)).toBe('step1')
    expect(avatarFrameAtWorklet(ageAt(resumedAtMs + 30_000), WINDOW_MS, false)).toBe('step1')
    // …or, for a repeated punch, its retract.
    expect(avatarFrameAtWorklet(ageAt(resumedAtMs + 1_000), WINDOW_MS, false, true)).toBe('step2')
    // It settles to guard by itself only when the new transport has counted
    // back up to the old tick: as long as the round had already run.
    expect(avatarFrameAtWorklet(ageAt(resumedAtMs + adoptedAtMs + 2_000), WINDOW_MS, false)).toBe(
      'guard',
    )
  })
})
