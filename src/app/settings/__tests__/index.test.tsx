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

import SettingsLanding, { QA_MODE_HINT } from '../index'
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

beforeEach(() => {
  __resetQaStoreForTests()
})

afterEach(() => {
  act(() => {
    for (const tree of mounted.splice(0)) tree.unmount()
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
      read: <T,>(_key: string, fallback: T): T => fallback,
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
