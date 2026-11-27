/**
 * `punchcraft://qa/run` (GH #291) — the route that stages a workout for the
 * unattended suite.
 *
 * The first on-device drive of this route staged the run perfectly and
 * then never left its own screen: `useLocalSearchParams()` returns a fresh
 * object on every render, the effect listed it as a dependency, and the
 * re-render caused by showing the staged request re-ran the effect — whose
 * cleanup cleared the navigation timer. The first case here reproduces
 * that churn on purpose. The rest pin the privilege model (autostart and
 * sim are downgraded when the QA flag is off), the invalid-link path (log,
 * render errors, never navigate) and the re-sent-intent path (re-navigate
 * only, never re-stage).
 */
import React from 'react'
import { Platform } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'

const mockReplace = jest.fn()
/** Every call returns a NEW object — the identity churn that broke the route on device. */
let mockParams: Record<string, string> = {}
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ ...mockParams }),
}))

import QaRunLauncher from '../run'
import { replaceSinks, type LogRecord } from '@diagnostics/logger'
import { __resetQaStoreForTests, useQaStore } from '@state/useQaStore'
import { useWorkoutStore } from '@state/useWorkoutStore'

const mounted: ReactTestRenderer[] = []
let records: LogRecord[] = []
const logged = (code: string): LogRecord[] => records.filter((r) => r.code === code)

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<QaRunLauncher />)
  })
  mounted.push(tree)
  return tree
}

function advance(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockReplace.mockClear()
  records = []
  replaceSinks([{ write: (r) => records.push(r) }])
  __resetQaStoreForTests()
  act(() => {
    useWorkoutStore.getState().resetRecipe()
  })
})

afterEach(() => {
  act(() => {
    for (const tree of mounted.splice(0)) tree.unmount()
  })
  jest.useRealTimers()
})

describe('qa/run', () => {
  it('stages the run, patches the recipe, and navigates to live — even as params identity churns', () => {
    // QA mode was switched on in Settings beforehand; the link only uses it.
    useQaStore.getState().setEnabled(true)
    mockParams = {
      workout: 'body-work',
      vocab: 'techniques',
      sim: 'captured-jam',
      autostart: '1',
      nonce: 'n-1',
    }
    render()

    // Staged synchronously in the mount effect.
    const run = useQaStore.getState().run
    expect(run).toMatchObject({
      workout: 'body-work',
      vocab: 'techniques',
      sim: 'captured-jam',
      autostart: true,
      nonce: 'n-1',
      autostartConsumed: false,
    })
    expect(useQaStore.getState().enabled).toBe(true)
    expect(useWorkoutStore.getState().selectedSampleKey).toBe('body-work')
    // The vocabulary reaches the RECIPE — the only thing the round-1 opener reads.
    expect(useWorkoutStore.getState().recipe.voiceVocabulary).toBe('names')
    expect(logged('workout.qa.run')).toHaveLength(1)
    // The capture says which device wrote it — the timing analyzer refuses
    // one the tablet did not.
    expect(logged('workout.qa.run')[0]?.fields.platform).toEqual({
      value: Platform.OS,
      class: 'safe',
    })

    // The bug: a re-render with a fresh params object must not cancel the
    // pending navigation.
    expect(mockReplace).not.toHaveBeenCalled()
    advance(249)
    expect(mockReplace).not.toHaveBeenCalled()
    advance(1)
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/punchcraft/live')
  })

  it('downgrades autostart and sim when QA mode is off, and says so', () => {
    mockParams = { workout: 'heavy-hands', sim: 'captured-jam', autostart: '1' }
    render()
    expect(useQaStore.getState().run).toMatchObject({ autostart: false, sim: 'none' })
    expect(logged('workout.qa.run.blocked')).toHaveLength(1)
    advance(250)
    // A public link still selects the workout and lands on live; it just cannot start it.
    expect(useWorkoutStore.getState().selectedSampleKey).toBe('heavy-hands')
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/punchcraft/live')
  })

  it('keeps autostart when the flag was already persisted on', () => {
    useQaStore.getState().setEnabled(true)
    mockParams = { workout: 'heavy-hands', autostart: '1' }
    render()
    expect(useQaStore.getState().run?.autostart).toBe(true)
    expect(logged('workout.qa.run.blocked')).toHaveLength(0)
  })

  it('"generated" mints a fresh build and honours an explicit seed', () => {
    mockParams = { workout: 'generated', seed: 'suite-seed-7' }
    render()
    expect(useWorkoutStore.getState().selectedSampleKey).toBeUndefined()
    expect(useWorkoutStore.getState().recipe.seed).toBe('suite-seed-7')
  })

  it('rejects an invalid link: logs, shows the errors, never navigates or stages', () => {
    mockParams = { workout: 'no-such-workout', autostart: 'maybe' }
    const tree = render()
    expect(logged('workout.qa.run.invalid')).toHaveLength(1)
    expect(useQaStore.getState().run).toBeNull()
    advance(10_000)
    expect(mockReplace).not.toHaveBeenCalled()
    expect(JSON.stringify(tree.toJSON())).toContain('QA run link rejected')
  })

  it('a re-sent intent with the same nonce re-navigates but does not re-stage', () => {
    useQaStore.getState().setEnabled(true)
    mockParams = { workout: 'body-work', autostart: '1', nonce: 'dup-1' }
    render()
    advance(250)
    expect(mockReplace).toHaveBeenCalledTimes(1)
    // Pretend the live screen consumed the autostart in the meantime.
    useQaStore.getState().consumeAutostart()

    render() // the driver re-sent the identical intent
    expect(logged('workout.qa.run.duplicate')).toHaveLength(1)
    // Not re-staged: the consumed latch survives, so the live screen cannot start twice.
    expect(useQaStore.getState().run?.autostartConsumed).toBe(true)
    expect(mockReplace).toHaveBeenCalledTimes(2)
  })
})

describe('a link cannot grant itself QA mode', () => {
  // `qa=1` used to set the flag, and the very next line read it back as the
  // authorization — so the link approved its own autostart. The flag is
  // persisted, so one link also left QA mode on for good. The scheme is
  // reachable from outside the app: anything that could open a URL could
  // start a simulated workout that was then saved as a real session.

  /** A settings repository that records what was written to it. */
  function recordingRepo() {
    const writes: Array<{ key: string; value: unknown }> = []
    const repo = {
      readChecked: <T,>(_key: string, normalize: (row: Record<string, unknown>) => T) => ({
        value: normalize({}),
        corrected: false,
      }),
      write: (key: string, value: unknown) => {
        writes.push({ key, value })
      },
      clear: () => {},
    }
    useQaStore.getState().load(repo as never)
    return writes
  }

  it('leaves QA mode off when the link asks to turn it on', () => {
    mockParams = { workout: 'heavy-hands', sim: 'captured-jam', autostart: '1', qa: '1' }
    render()
    expect(useQaStore.getState().enabled).toBe(false)
  })

  it('therefore neither autostarts nor throws simulated punches', () => {
    mockParams = { workout: 'heavy-hands', sim: 'captured-jam', autostart: '1', qa: '1' }
    render()
    expect(useQaStore.getState().run).toMatchObject({ autostart: false, sim: 'none' })
    expect(logged('workout.qa.run.cannotEnable')).toHaveLength(1)
    expect(logged('workout.qa.run.blocked')).toHaveLength(1)
  })

  it('writes nothing to storage, so the next cold start is not privileged either', () => {
    const writes = recordingRepo()
    mockParams = { workout: 'heavy-hands', autostart: '1', qa: '1' }
    render()
    expect(writes).toEqual([])
  })

  it('still does what an unprivileged link may do, and says why it did no more', () => {
    mockParams = { workout: 'heavy-hands', autostart: '1', qa: '1' }
    const tree = render()
    advance(250)
    expect(useWorkoutStore.getState().selectedSampleKey).toBe('heavy-hands')
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/punchcraft/live')
    expect(tree.root.findAllByProps({ testID: 'qa-run-blocked' }, { deep: false })).toHaveLength(1)
  })

  it('can switch QA mode OFF — a link may always make itself less privileged', () => {
    const writes = recordingRepo()
    useQaStore.getState().setEnabled(true)
    writes.length = 0

    mockParams = { workout: 'heavy-hands', autostart: '1', qa: '0' }
    render()
    expect(useQaStore.getState().enabled).toBe(false)
    expect(useQaStore.getState().run?.autostart).toBe(false)
    expect(writes).toEqual([{ key: 'qa.mode', value: { enabled: false } }])
  })

  it('needs no qa parameter once QA mode is on, and does not complain about one', () => {
    useQaStore.getState().setEnabled(true)
    mockParams = { workout: 'heavy-hands', sim: 'captured-jam', autostart: '1', qa: '1' }
    const tree = render()
    expect(useQaStore.getState().run).toMatchObject({ autostart: true, sim: 'captured-jam' })
    expect(logged('workout.qa.run.cannotEnable')).toHaveLength(0)
    expect(tree.root.findAllByProps({ testID: 'qa-run-blocked' }, { deep: false })).toHaveLength(0)
  })
})
