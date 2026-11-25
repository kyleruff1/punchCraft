/**
 * The runner says which compiled timeline it is running (T-2).
 *
 * `verify-first-round` can only tie a capture to its manifest by the hash the
 * app logs. That hash used to be logged solely by the score path's
 * `slotDispatcher.armed` record — and no shipped sample takes the score path,
 * so every capture the verification suite took was unverifiable. The runner
 * now logs `workout.timeline.provenance` on either path.
 *
 * The second half is the part that matters for the suite: the hash the app
 * computes must be the hash the checked-in manifest carries, or every drive
 * would read STALE. Both sides are compared here for every shipped sample.
 */
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { View } from 'react-native'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { useWorkoutRunner } from '../_useWorkoutRunner'
import { createFakeClock } from '@testing/fakeClock'
import { addSink, replaceSinks, type LogRecord } from '@diagnostics/logger'
import { getSampleWorkout, listSampleWorkouts } from '@domain/workout/samples'
import { resetLive, useLiveStore } from '@state/useWorkoutStore'
import type { GeneratedWorkout } from '@domain/workout/GeneratedWorkout'
import type { PunchEventSource } from '@domain/punch/PunchEventSource'

/** Relative to the repo root, where jest runs — as the other suites read files. */
const MANIFESTS = join(process.cwd(), 'tools', 'analysis', 'manifests')

const silentSource: PunchEventSource = {
  id: 'fake',
  capability: { hand: true, timestamp: true, punchType: 'none', velocity: true },
  subscribe: () => () => {},
  start: () => {},
  stop: () => {},
}

/** Arm the runner for `workout` and return everything it logged doing so. */
function armAndCollect(workout: GeneratedWorkout): LogRecord[] {
  const records: LogRecord[] = []
  replaceSinks([])
  addSink({ write: (record) => records.push(record) })

  function Probe(): React.JSX.Element {
    useWorkoutRunner({
      workout,
      source: silentSource,
      // The stance the live screen arms with (`live.tsx`).
      stance: workout.recipe.defaultStance,
      clock: createFakeClock(),
      persistence: null,
    })
    return <View />
  }
  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<Probe />)
  })
  act(() => {
    tree.unmount()
  })
  return records
}

const provenanceOf = (records: LogRecord[]): Record<string, unknown> | undefined => {
  const record = records.find((r) => r.code === 'workout.timeline.provenance')
  if (!record) return undefined
  return Object.fromEntries(Object.entries(record.fields).map(([k, v]) => [k, v.value]))
}

beforeEach(() => {
  jest.useFakeTimers()
  resetLive()
})

afterEach(() => {
  jest.useRealTimers()
  replaceSinks([])
  act(() => {
    useLiveStore.getState().resetLive()
  })
})

const SAMPLES = listSampleWorkouts().map((sample) => sample.key)

describe('timeline provenance', () => {
  it.each(SAMPLES)('%s: logs the hash its checked-in manifest carries', (key) => {
    const workout = getSampleWorkout(key)!.workout
    const logged = provenanceOf(armAndCollect(workout))
    expect(logged).toBeDefined()
    expect(logged?.workout).toBe(workout.id)

    const manifestPath = join(MANIFESTS, `${workout.id}.json`)
    if (!existsSync(manifestPath)) return // not driven by the suite
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      identity: { timelineHash: string }
    }
    expect(logged?.timelineHash).toBe(manifest.identity.timelineHash)
  })

  it('says which coach path the run is on', () => {
    // Every shipped sample is capped at `voiceMode: 'minimal'`, which keeps
    // the score dispatcher unarmed: the click path.
    const workout = getSampleWorkout('heavy-hands')!.workout
    expect(provenanceOf(armAndCollect(workout))?.path).toBe('click')
  })

  it('does not report a compile failure for any shipped sample', () => {
    for (const key of SAMPLES) {
      const records = armAndCollect(getSampleWorkout(key)!.workout)
      expect(records.filter((r) => r.code === 'workout.timeline.provenanceFailed')).toEqual([])
    }
  })
})
