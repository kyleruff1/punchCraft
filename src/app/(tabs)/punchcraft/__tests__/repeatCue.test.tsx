/**
 * A combination the athlete asks to repeat is part of the record (M-5).
 *
 * "Repeat (hold)" injects a copy of the current cue into the engine. That
 * copy exists only there, and two things followed:
 *
 * - The runner turned a settled cue into `cue_results` rows by looking the
 *   cue up in the static timeline. The copy is not in it, so the rep the
 *   athlete asked for — and threw — was never written, and nothing said so.
 * - The copy took `repeatIndex + 1`, which for any rep but the block's last
 *   is the natural next rep's own index. Had its rows been written, they
 *   would have collided with that rep on the table's primary key and rolled
 *   the whole session back.
 *
 * Real runner, real migrated SQLite.
 */
import React, { useImperativeHandle } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { View } from 'react-native'

import {
  useWorkoutRunner,
  TICK_INTERVAL_MS,
  type SessionEndOutcome,
  type WorkoutRunner,
} from '../_useWorkoutRunner'
import { DEFAULT_COUNTDOWN_MS } from '@domain/session/WorkoutSessionClock'
import { createFakeClock } from '@testing/fakeClock'
import { createMigratedDb } from '@storage/__tests__/helpers/memoryDb'
import { SessionRepository } from '@storage/repositories/SessionRepository'
import { WorkoutRepository } from '@storage/repositories/WorkoutRepository'
import { defaultRecipe } from '@domain/workout/WorkoutRecipe'
import { resetLive, useLiveStore } from '@state/useWorkoutStore'
import type { GeneratedWorkout } from '@domain/workout/GeneratedWorkout'
import type { PunchEventSource } from '@domain/punch/PunchEventSource'

const WORK_MS = 12_000

/** One round, one 1-2 thrown twice: reps 0 and 1 of block `r1-b1`. */
const WORKOUT: GeneratedWorkout = {
  id: 'repeat-cue-fixture',
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

const silentSource: PunchEventSource = {
  id: 'fake',
  capability: { hand: true, timestamp: true, punchType: 'none', velocity: true },
  subscribe: () => () => {},
  start: () => {},
  stop: () => {},
}

/** Run the fixture, holding Repeat while the first combination is on stage. */
function runWithRepeat() {
  const clock = createFakeClock()
  const db = createMigratedDb()
  const persistence = {
    db,
    sessions: new SessionRepository(db),
    workouts: new WorkoutRepository(db),
  }
  const outcomes: SessionEndOutcome[] = []
  const ref = React.createRef<WorkoutRunner>()

  function Probe(): React.JSX.Element {
    const runner = useWorkoutRunner({
      workout: WORKOUT,
      source: silentSource,
      stance: 'orthodox',
      clock,
      persistence,
      onSessionEnded: (outcome) => {
        outcomes.push(outcome)
      },
    })
    useImperativeHandle(ref, () => runner, [runner])
    return <View />
  }

  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<Probe />)
  })
  const step = (ms: number): void => {
    act(() => {
      for (let elapsed = 0; elapsed < ms; elapsed += TICK_INTERVAL_MS) {
        clock.advance(TICK_INTERVAL_MS)
        jest.advanceTimersByTime(TICK_INTERVAL_MS)
      }
    })
  }

  act(() => {
    ;(ref.current as WorkoutRunner).start()
  })
  // Into the round, with the first combination — rep 0 — on stage.
  step(DEFAULT_COUNTDOWN_MS + TICK_INTERVAL_MS * 2)
  act(() => {
    ;(ref.current as WorkoutRunner).repeatCue()
  })
  step(WORK_MS + TICK_INTERVAL_MS * 4)

  const rows = db.raw
    .prepare(
      `SELECT repeat_index AS rep, token_index AS token FROM cue_results
        WHERE block_id = 'r1-b1' ORDER BY repeat_index, token_index`,
    )
    .all() as Array<{ rep: number; token: number }>

  act(() => {
    tree.unmount()
  })
  return { outcomes, rows }
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

describe('a repeated combination', () => {
  it('does not cost the session', () => {
    expect(runWithRepeat().outcomes[0]?.status).toBe('persisted')
  })

  it('is written, under a repeat index of its own', () => {
    const { rows } = runWithRepeat()
    // Reps 0 and 1 are the block's own; rep 2 is the one the athlete asked for.
    expect([...new Set(rows.map((row) => row.rep))]).toEqual([0, 1, 2])
  })

  it('gets a row for every punch it called, like any other rep', () => {
    const { rows } = runWithRepeat()
    expect(rows.filter((row) => row.rep === 2).map((row) => row.token)).toEqual([0, 1])
    expect(rows).toHaveLength(6)
  })
})
