/**
 * Scoring does not depend on how long the app has been running.
 *
 * A punch is stamped on the monotonic clock — `performance.now()`, app
 * uptime. A cue is written on the round's work clock, origin at the bell.
 * The runner used to hand the matcher the raw stamp, and the matcher
 * subtracted a work-clock moment from it: every `cue_results.offset_ms` was
 * the app's uptime at round start, `timingWindowPct` was always 0, and the
 * on-beat haptic never fired.
 *
 * No test saw it, for two reasons this suite is built to remove:
 *
 * - The fixtures derived each punch's stamp from the cue's own schedule, so
 *   the assertions checked `(base + d) - base === d`. Here punches come from
 *   a source that stamps them off the SAME clock the runner runs on, the way
 *   the tracker and the simulator do.
 * - The fake clock started at 0, where uptime and round time are close to
 *   one number line. Here every case runs at four origins, and the persisted
 *   rows must be identical across all of them.
 *
 * Real runner, real migrated SQLite: the rows compared are the rows a tablet
 * would hold.
 */
import React, { useImperativeHandle } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { View } from 'react-native'

import { useWorkoutRunner, TICK_INTERVAL_MS, type WorkoutRunner } from '../_useWorkoutRunner'
import { DEFAULT_COUNTDOWN_MS } from '@domain/session/WorkoutSessionClock'
import { createFakeClock, type FakeClock } from '@testing/fakeClock'
import { createMigratedDb } from '@storage/__tests__/helpers/memoryDb'
import { SessionRepository } from '@storage/repositories/SessionRepository'
import { WorkoutRepository } from '@storage/repositories/WorkoutRepository'
import { defaultRecipe } from '@domain/workout/WorkoutRecipe'
import { bpmForRecipe } from '@domain/workout/cadence'
import { expandTimeline, type CueInstance } from '@domain/programs/CueTimeline'
import { tokenScheduledMs } from '@domain/programs/CueMatcher'
import { TIMING_TIGHT_MS } from '@domain/programs/cueScoring'
import { resetLive, useLiveStore } from '@state/useWorkoutStore'
import type { HapticOutputPort } from '@domain/coach/HapticOutputPort'
import type { GeneratedWorkout } from '@domain/workout/GeneratedWorkout'
import type { PunchEventSource } from '@domain/punch/PunchEventSource'
import type { TrackerPunchEvent, PunchHand } from '@domain/punch/PunchEvent'

const WORK_MS = 12_000
const COUNTDOWN_MS = DEFAULT_COUNTDOWN_MS

/** One round, one 1-2 thrown twice. Two cues, two expectations each. */
const WORKOUT: GeneratedWorkout = {
  id: 'clock-origin-fixture',
  recipe: defaultRecipe(),
  schedule: [
    {
      id: 'r1',
      order: 1,
      kind: 'round',
      countsTowardGoal: true,
      theme: 'Round 1',
      workDurationMs: WORK_MS,
      restAfterMs: 0,
      targetPunches: 4,
      blocks: [
        {
          id: 'r1-b1',
          kind: 'repeated-combo',
          stance: 'inherit',
          startOffsetMs: 0,
          durationMs: 1_000,
          gapBeats: 2,
          repeat: 2,
          tokens: [
            { kind: 'punch', number: 1, body: false, beatOffset: 0 },
            { kind: 'punch', number: 2, body: false, beatOffset: 1 },
          ],
        },
      ],
    },
  ],
  roundPunchTargets: [4],
  expectedTechniqueDistribution: {},
  estimatedActivePunchesPerMinute: 60,
  warnings: [],
}

/** The same expansion the runner performs, so the test knows the schedule. */
const CUES: CueInstance[] = expandTimeline(WORKOUT, 'orthodox', bpmForRecipe(WORKOUT.recipe))[0]!
  .cues

/**
 * Roughly what a tracker reports as its own timestamp: device epoch
 * milliseconds. A third clock, nowhere near the other two, and present on
 * every real event — so it is present here, where it must change nothing.
 */
const DEVICE_EPOCH_MS = 1_790_000_000_000

/** A source that stamps punches off the runner's own clock, like the real ones. */
class ClockStampedSource implements PunchEventSource {
  readonly id = 'fake'
  readonly capability = { hand: true, timestamp: true, punchType: 'none' as const, velocity: true }
  private listeners: Array<(event: TrackerPunchEvent) => void> = []
  private seq = 0

  constructor(private readonly clock: FakeClock) {}

  subscribe(listener: (event: TrackerPunchEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  start(): void {}
  stop(): void {}

  emit(hand: PunchHand): void {
    this.seq += 1
    const event: TrackerPunchEvent = {
      id: `e${this.seq}`,
      sourceFrameId: `f${this.seq}`,
      deviceId: hand === 'left' ? 'LEFT' : 'RIGHT',
      hand,
      receivedMonotonicTimeMs: this.clock.now(),
      // Distinct per punch, as on hardware. `punch_events` dedups on it, and a
      // deduped punch a cue result names would roll the whole session back.
      trackerTimestampMs: DEVICE_EPOCH_MS + this.seq * 1_000,
      receivedWallTimeIso: new Date(0).toISOString(),
      velocityRaw: 50,
      velocityUnit: 'tracker-unit',
      recovered: false,
      decoderId: 'fake',
      decoderVersion: '1',
      qualityFlags: [],
    }
    for (const listener of [...this.listeners]) listener(event)
  }
}

interface StoredRow {
  block_id: string
  repeat_index: number
  token_index: number
  outcome: string
  offset_ms: number | null
}

interface Run {
  rows: StoredRow[]
  /** Every per-punch `strike` the haptic port was asked for, in order. */
  hitStrikes: string[]
  /** `timingWindowPct` of the first combination, read once it had settled. */
  firstCueTimingPct: number | undefined
}

/**
 * Run the fixture with the fake clock starting at `originMs`.
 *
 * The script is the same every time and is written in ROUND time — "80 ms
 * after the first call", never a clock reading — so the only thing that
 * differs between two runs is how long the app claims to have been up.
 *
 *   combo 1: the jab 80 ms late, the cross 40 ms early   → both on the beat
 *   combo 2: the jab well outside the tight window; the cross never thrown
 */
function run(originMs: number): Run {
  const clock = createFakeClock(originMs)
  const source = new ClockStampedSource(clock)
  const db = createMigratedDb()
  const persistence = {
    db,
    sessions: new SessionRepository(db),
    workouts: new WorkoutRepository(db),
  }
  const strikes: string[] = []
  const haptics: HapticOutputPort = {
    strike: (kind) => {
      strikes.push(kind)
    },
    punch: () => {},
  }
  const ref = React.createRef<WorkoutRunner>()

  function Probe(): React.JSX.Element {
    const runner = useWorkoutRunner({
      workout: WORKOUT,
      source,
      stance: 'orthodox',
      clock,
      persistence,
      haptics,
    })
    useImperativeHandle(ref, () => runner, [runner])
    return <View />
  }

  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<Probe />)
  })

  /** The round's work clock as the script knows it: one round, never paused. */
  const workNow = (): number => clock.now() - originMs - COUNTDOWN_MS

  /** Reach an exact round moment: whole ticks, then the clock alone. */
  const toWork = (targetMs: number): void => {
    act(() => {
      while (workNow() + TICK_INTERVAL_MS <= targetMs) {
        clock.advance(TICK_INTERVAL_MS)
        jest.advanceTimersByTime(TICK_INTERVAL_MS)
      }
      // A punch lands when it lands, not on a tick — so the last stretch
      // moves the clock without running one.
      if (workNow() < targetMs) clock.advance(targetMs - workNow())
    })
  }

  const throwAt = (cue: CueInstance, n: number, lateMs: number): void => {
    const expected = cue.expectedPunches[n]!
    toWork(tokenScheduledMs(cue, expected) + lateMs)
    act(() => {
      source.emit(expected.hand)
    })
  }

  const [first, second] = CUES as [CueInstance, CueInstance]

  act(() => {
    ;(ref.current as WorkoutRunner).start()
  })
  toWork(0)

  throwAt(first, 0, 80)
  throwAt(first, 1, -40)

  // The second combination's window opening settles the first.
  toWork(second.scheduledStartMs + TICK_INTERVAL_MS)
  const firstCueTimingPct = (ref.current as WorkoutRunner).readResults().lastScore?.timingWindowPct

  throwAt(second, 0, TIMING_TIGHT_MS + 60)
  toWork(WORK_MS + TICK_INTERVAL_MS * 4)

  const rows = (
    db.raw
      .prepare(
        `SELECT block_id, repeat_index, token_index, outcome, offset_ms
           FROM cue_results ORDER BY repeat_index, token_index`,
      )
      .all() as unknown as StoredRow[]
  ).map((row) => ({
    ...row,
    // Microsecond rounding: the projection is float arithmetic, and a day of
    // uptime leaves a few ulps that have nothing to do with the property.
    offset_ms: row.offset_ms === null ? null : Math.round(row.offset_ms * 1_000) / 1_000,
  }))

  act(() => {
    tree.unmount()
  })
  // 'good' / 'perfect' are the per-punch on-beat reward. The completion buzz
  // for a finished combination is a different signal with its own rule.
  const hitStrikes = strikes.filter((kind) => kind === 'good' || kind === 'perfect')
  return { rows, hitStrikes, firstCueTimingPct }
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

// ---------------------------------------------------------------------------

describe('the fixture', () => {
  it('is two combinations of a left then a right', () => {
    expect(CUES.map((cue) => cue.expectedPunches.map((p) => p.hand))).toEqual([
      ['left', 'right'],
      ['left', 'right'],
    ])
  })
})

describe.each([0, 1_000, 3_600_000, 86_400_000])(
  'with the app up for %i ms before the workout',
  (originMs) => {
    it("stores each punch's distance from its call, not the app's uptime", () => {
      const { rows } = run(originMs)
      const matched = rows.filter((row) => row.outcome === 'matched')
      expect(matched.map((row) => row.offset_ms)).toEqual([80, -40, TIMING_TIGHT_MS + 60])
    })

    it('stores no offset for the call nothing answered', () => {
      const { rows } = run(originMs)
      expect(rows).toHaveLength(4)
      const missed = rows.filter((row) => row.outcome === 'missed')
      expect(missed.map((row) => row.offset_ms)).toEqual([null])
    })

    it('scores a combination thrown on the beat as on time', () => {
      expect(run(originMs).firstCueTimingPct).toBe(100)
    })

    it('buzzes for the two punches on the beat and not for the late one', () => {
      expect(run(originMs).hitStrikes).toEqual(['good', 'good'])
    })

    it('stores exactly the rows a workout started at uptime zero does', () => {
      expect(run(originMs).rows).toEqual(run(0).rows)
    })
  },
)
