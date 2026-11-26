/**
 * The Fix button's two jobs: the Bluetooth bounce it has always prompted, and
 * — when the bond diagnosis says a glove is probably not paired (H13) —
 * sending the athlete to pair it instead.
 */
import React from 'react'
import { Platform } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'

const mockOpenSettings = jest.fn(async () => undefined)
const mockBounce = jest.fn(async () => ({ status: 'ok' as const }))

jest.mock('@ble/openBluetoothSettings', () => ({
  openBluetoothSettings: () => mockOpenSettings(),
}))
jest.mock('@ble/bounceBluetooth', () => ({
  bounceBluetoothAndReconnect: () => mockBounce(),
}))

import { ConnectionBadge, resolveVisual } from '../ConnectionBadge'
import { FixTrackerButton } from '../FixTrackerButton'
import { useTrackerStore, type SlotState } from '@/state/useTrackerStore'

const slot = (state: SlotState['state']): SlotState => ({ deviceId: 'D7:34:B4:27:D5:84', state })

let restoreOs: { restore: () => void } | null = null
const mounted: ReactTestRenderer[] = []

function render(element: React.JSX.Element): ReactTestRenderer {
  let tree!: ReactTestRenderer
  act(() => {
    tree = create(element)
  })
  mounted.push(tree)
  return tree
}

const hint = (tree: ReactTestRenderer, testID: string): string[] =>
  tree.root.findAllByProps({ testID }, { deep: false }).map((node) => String(node.props.children))

async function pressFix(tree: ReactTestRenderer): Promise<void> {
  await act(async () => {
    tree.root.findByProps({ testID: 'fix-tracker-connection' }).props.onPress()
  })
}

beforeEach(() => {
  restoreOs = jest.replaceProperty(Platform, 'OS', 'android')
  mockOpenSettings.mockClear()
  mockBounce.mockClear()
  useTrackerStore.setState({
    slots: { left: null, right: null },
    bond: { left: 'unknown', right: 'unknown' },
  })
})

afterEach(() => {
  act(() => {
    for (const tree of mounted.splice(0)) tree.unmount()
  })
  restoreOs?.restore()
})

describe('FixTrackerButton', () => {
  it('bounces Bluetooth, and says nothing about pairing, in the ordinary case', async () => {
    const tree = render(<FixTrackerButton />)
    expect(hint(tree, 'fix-tracker-pair-hint')).toEqual([])
    await pressFix(tree)
    expect(mockBounce).toHaveBeenCalledTimes(1)
    expect(mockOpenSettings).not.toHaveBeenCalled()
  })

  it('names the glove that is probably not paired, and why', () => {
    useTrackerStore.setState({ bond: { left: 'unknown', right: 'probably-unbonded' } })
    const tree = render(<FixTrackerButton />)
    expect(hint(tree, 'fix-tracker-pair-hint')).toEqual([
      expect.stringMatching(/^The right glove dropped 30–45 seconds after connecting, twice/),
    ])
  })

  it('opens Bluetooth settings to pair, without waiting for a bounce', async () => {
    useTrackerStore.setState({ bond: { left: 'probably-unbonded', right: 'unknown' } })
    const tree = render(<FixTrackerButton />)
    await pressFix(tree)
    expect(mockOpenSettings).toHaveBeenCalledTimes(1)
    expect(mockBounce).not.toHaveBeenCalled()
    // No "Waiting for Bluetooth bounce…": nothing is being waited for.
    expect(hint(tree, 'fix-tracker-status')).toEqual([])
    expect(tree.root.findByProps({ testID: 'fix-tracker-connection' }).props.disabled).toBe(false)
  })

  it('goes back to its ordinary job once the glove is connected again', async () => {
    useTrackerStore.setState({ bond: { left: 'probably-unbonded', right: 'unknown' } })
    const tree = render(<FixTrackerButton />)
    act(() => {
      useTrackerStore.setState({ slots: { left: slot('ready'), right: null } })
    })
    expect(hint(tree, 'fix-tracker-pair-hint')).toEqual([])
    await pressFix(tree)
    expect(mockBounce).toHaveBeenCalledTimes(1)
  })

  it('says nothing for a glove that has only dropped once', () => {
    useTrackerStore.setState({ bond: { left: 'suspect', right: 'unknown' } })
    expect(hint(render(<FixTrackerButton />), 'fix-tracker-pair-hint')).toEqual([])
  })
})

describe('ConnectionBadge', () => {
  it('reads "Not paired?" for a glove that is down and probably unbonded', () => {
    expect(resolveVisual(slot('dormant'), 'probably-unbonded').label).toBe('Not paired?')
    // The slot is cleared between reconnect attempts; the verdict outlives it.
    expect(resolveVisual(null, 'probably-unbonded').label).toBe('Not paired?')
  })

  it('reads as it always did otherwise', () => {
    expect(resolveVisual(slot('dormant')).label).toBe('Disconnected')
    expect(resolveVisual(slot('dormant'), 'suspect').label).toBe('Disconnected')
    expect(resolveVisual(null).label).toBe('(unassigned)')
    expect(resolveVisual(slot('ready'), 'probably-unbonded').label).toBe('Connected')
    expect(resolveVisual(slot('connecting'), 'probably-unbonded').label).toBe('Connecting…')
  })

  it('puts the label in the pill and in what a screen reader hears', () => {
    const tree = render(<ConnectionBadge hand="left" slot={null} bondVerdict="probably-unbonded" />)
    const pill = tree.root.findByProps({ accessibilityRole: 'button' })
    expect(pill.props.accessibilityLabel).toBe('L: Not paired? — tap to reconnect')
  })
})
