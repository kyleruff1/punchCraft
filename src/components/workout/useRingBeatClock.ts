/**
 * Ring beat clock — the token walk on the UI thread (MVP v2, GH #305).
 *
 * ## v3: THE WHOLE ROUND LIVES ON THE UI THREAD
 *
 * Two staging designs died before this one:
 *  - adopt-what-JS-calls-current: promoted bars 60-600ms late (JS tick).
 *  - stage-one-successor-ahead: a single pending slot, and the engine
 *    (early sim/tracker completions) flips current FASTER than boundary
 *    promotes consume it — each new successor clobbered the un-promoted
 *    one and whole bars were swallowed (captured: stages #35..#39 in 5s,
 *    then promote #38; bars #34-37 never walked; on-glass "stalled on
 *    the last node… hugs the far right").
 *
 * The round is fully AUTHORED, so no runtime handoff is needed at all:
 * JS stages the ENTIRE round's bar plan once at round start, and the
 * worklet iterates it by clock — `while (elapsed >= sched[idx+1]) idx++`.
 * Nothing is left to race: no per-rep effect, no pending slot, no engine
 * involvement. The engine scores; the schedule walks.
 *
 * A cold or late join SNAPS to the current bar and ordinal (option-C:
 * never replay what is over); normal operation advances one bar / one
 * node at a time because the clock does.
 *
 * `beatOrdinalAtMsWorklet` (ringBeatMath) stays the hand-mirror of
 * `beatOrdinalAtMs`, pinned by a parity test.
 */
import { useEffect } from 'react'
import {
  runOnJS,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated'

import { logger } from '@/diagnostics/logger'
import { sharedWorkElapsedMs, type SharedWorkClock } from '@domain/timing/SharedWorkClock'
import { beatOrdinalAtMsWorklet } from './ringBeatMath'
import { ringPromoteFields } from './ringLog'

/** One bar of the round's walk plan, in walk order. */
export interface WalkBar {
  epoch: string
  scheduledStartMs: number
  tokenOffsetsMs: readonly number[]
  /** Token indexes of the expected punches, punch-ordinal order. */
  expectedTokenIndexes: readonly number[]
}

export interface RoundWalkPlan {
  roundIndex: number
  bars: readonly WalkBar[]
}

/**
 * A step of the walk, as the UI thread saw it: the bar, the ring stepped to
 * (-1 clears the row for a new bar), the ring stepped from, and the two
 * clocks of the frame it happened on — the work-elapsed projected from the
 * ring clock, and the frame's own timestamp. See `ringLog.ts`.
 */
export type OnRingStep = (
  epoch: string,
  ordinal: number,
  from: number,
  workElapsedMs: number,
  frameMs: number,
) => void

export function useRingBeatClock(
  plan: RoundWalkPlan | null,
  clock: SharedValue<SharedWorkClock> | undefined,
  onOrdinal: OnRingStep,
  displayOrdinal?: SharedValue<number>,
): void {
  // The whole plan as parallel shared arrays — staged ONCE per round.
  const epochs = useSharedValue<string[]>([])
  const scheds = useSharedValue<number[]>([])
  const offsets = useSharedValue<number[][]>([])
  const expected = useSharedValue<number[][]>([])
  const barIdx = useSharedValue(-1)
  const lastOrdinal = useSharedValue(-1)
  const planRound = useSharedValue(-1)
  const active = useSharedValue(false)

  const onPromote = (
    epochV: string,
    lateMs: number,
    previousEpoch: string,
    previousReached: number,
    frameMs: number,
  ): void => {
    logger.info(
      'workout.ring.promote',
      'bar promoted',
      ringPromoteFields({ epoch: epochV, lateMs, previousEpoch, previousReached, frameMs }),
    )
  }

  const roundIndex = plan?.roundIndex ?? -1
  const barCount = plan?.bars.length ?? 0
  useEffect(() => {
    if (!plan || !clock || plan.bars.length === 0) {
      active.value = false
      return
    }
    epochs.value = plan.bars.map((b) => b.epoch)
    scheds.value = plan.bars.map((b) => b.scheduledStartMs)
    offsets.value = plan.bars.map((b) => [...b.tokenOffsetsMs])
    expected.value = plan.bars.map((b) => [...b.expectedTokenIndexes])
    barIdx.value = -1
    lastOrdinal.value = -1
    if (displayOrdinal) displayOrdinal.value = -1
    planRound.value = plan.roundIndex
    active.value = true
    // Keyed on the ROUND, nothing else — one staging per round, no
    // per-rep effects left to race. (The avatar dep-stomp lesson, third
    // application.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundIndex, barCount, clock])

  const cb = useFrameCallback(({ timestamp }) => {
    'worklet'
    if (!active.value || !clock) return
    const c = clock.value
    if (!c.running || c.roundIndex !== planRound.value) return
    const elapsed = sharedWorkElapsedMs(c, timestamp)
    const s = scheds.value
    const n = s.length
    // Advance to the bar the CLOCK says we are in. Normal operation steps
    // once per boundary; a cold/late join walks forward within one frame
    // and snaps. Each crossing emits promote + clear, so a swallowed bar
    // would be VISIBLE in the log — by construction none remain.
    let idx = barIdx.value
    while (idx + 1 < n && elapsed >= s[idx + 1]!) {
      // How far the bar being left got — read before the row is cleared.
      // A bar the clock stepped straight over reached nothing, and says so.
      const previousReached = lastOrdinal.value
      const previousEpoch = idx >= 0 ? epochs.value[idx]! : ''
      idx += 1
      barIdx.value = idx
      lastOrdinal.value = -1
      if (displayOrdinal) displayOrdinal.value = -1
      runOnJS(onPromote)(
        epochs.value[idx]!,
        elapsed - s[idx]!,
        previousEpoch,
        previousReached,
        timestamp,
      )
      runOnJS(onOrdinal)(epochs.value[idx]!, -1, previousReached, elapsed, timestamp)
    }
    if (idx < 0) return
    const target = beatOrdinalAtMsWorklet(
      s[idx]!,
      offsets.value[idx]!,
      expected.value[idx]!,
      elapsed,
    )
    const from = lastOrdinal.value
    if (target <= from) return
    lastOrdinal.value = target
    if (displayOrdinal) displayOrdinal.value = target
    // The frame that lit the ring, and what both clocks read on it: the
    // log line itself is written a thread-hop later and carries no time.
    runOnJS(onOrdinal)(epochs.value[idx]!, target, from, elapsed, timestamp)
  })

  useEffect(() => {
    // NOT gated on reducedMotion — freezing the walk strands the athlete;
    // ActiveRing already renders statically under reduced motion.
    cb.setActive(!!clock && roundIndex >= 0 && barCount > 0)
  }, [cb, clock, roundIndex, barCount])
}
