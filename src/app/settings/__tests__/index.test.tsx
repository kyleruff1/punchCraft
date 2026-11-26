/**
 * The Settings landing screen's QA mode switch.
 *
 * This switch is the ONLY way QA mode gets turned on. A `punchcraft://qa/run`
 * link can use the mode and can switch it off, but cannot switch it on —
 * a URL anyone can open must not be able to grant itself the right to start
 * a workout full of simulated punches. So what this screen says and does is
 * the consent, not decoration.
 */
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}))

const mockStartAmbient = jest.fn(() => true)
const mockStopAmbient = jest.fn(async () => undefined)
jest.mock('@capture/getCaptureService', () => ({
  startAmbientCapture: () => mockStartAmbient(),
  stopAmbientCapture: () => mockStopAmbient(),
}))

import SettingsLanding, { KEEP_RAW_FRAMES_HINT, QA_MODE_HINT } from '../index'
import { AMBIENT_LIMITS } from '@capture/ambientCapture'
import { __resetCaptureSettingsForTests } from '@state/useCaptureSettingsStore'
import { __resetQaStoreForTests, useQaStore } from '@state/useQaStore'

const mounted: ReactTestRenderer[] = []

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<SettingsLanding />)
  })
  mounted.push(tree)
  return tree
}

const qaSwitch = (tree: ReactTestRenderer) => tree.root.findByProps({ testID: 'qa-mode-switch' })
const rawFramesSwitch = (tree: ReactTestRenderer) =>
  tree.root.findByProps({ testID: 'keep-raw-frames-switch' })

beforeEach(() => {
  __resetQaStoreForTests()
})

afterEach(() => {
  act(() => {
    for (const tree of mounted.splice(0)) tree.unmount()
  })
})

describe('keep raw glove data switch (N-7)', () => {
  beforeEach(() => {
    mockStartAmbient.mockClear()
    mockStopAmbient.mockClear()
    __resetCaptureSettingsForTests()
  })

  it('is on until someone turns it off', () => {
    expect(rawFramesSwitch(render()).props.value).toBe(true)
  })

  it('turns frame keeping off, and on again', () => {
    const tree = render()
    act(() => {
      rawFramesSwitch(tree).props.onValueChange(false)
    })
    expect(rawFramesSwitch(tree).props.value).toBe(false)
    expect(mockStopAmbient).toHaveBeenCalledTimes(1)
    act(() => {
      rawFramesSwitch(tree).props.onValueChange(true)
    })
    expect(rawFramesSwitch(tree).props.value).toBe(true)
    expect(mockStartAmbient).toHaveBeenCalledTimes(1)
  })

  it('says how long the data is kept, from the limit itself', () => {
    expect(KEEP_RAW_FRAMES_HINT).toContain(`${AMBIENT_LIMITS.retentionDays} days`)
  })
})

describe('QA mode switch', () => {
  it('is off until someone turns it on', () => {
    expect(qaSwitch(render()).props.value).toBe(false)
  })

  it('turns QA mode on', () => {
    const tree = render()
    act(() => {
      qaSwitch(tree).props.onValueChange(true)
    })
    expect(useQaStore.getState().enabled).toBe(true)
    expect(qaSwitch(tree).props.value).toBe(true)
  })

  it('turns it off again', () => {
    useQaStore.getState().setEnabled(true)
    const tree = render()
    act(() => {
      qaSwitch(tree).props.onValueChange(false)
    })
    expect(useQaStore.getState().enabled).toBe(false)
  })

  it('persists the choice, so the unattended suite survives a cold start', () => {
    const writes: Array<{ key: string; value: unknown }> = []
    useQaStore.getState().load({
      readChecked: <T,>(_key: string, normalize: (row: Record<string, unknown>) => T) => ({
        value: normalize({}),
        corrected: false,
      }),
      write: (key: string, value: unknown) => {
        writes.push({ key, value })
      },
      clear: () => {},
    } as never)

    const tree = render()
    act(() => {
      qaSwitch(tree).props.onValueChange(true)
    })
    expect(writes).toEqual([{ key: 'qa.mode', value: { enabled: true } }])
  })

  it('says in plain words what switching it on allows', () => {
    const text = JSON.stringify(render().toJSON())
    expect(text).toContain('QA mode')
    expect(QA_MODE_HINT).toMatch(/start a workout/)
    expect(QA_MODE_HINT).toMatch(/simulated punches/)
    expect(QA_MODE_HINT).toMatch(/Leave it off otherwise/)
  })
})
