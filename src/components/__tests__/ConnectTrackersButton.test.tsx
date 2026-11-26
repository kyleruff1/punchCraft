/**
 * The Connect button is offered only where it can work: it starts a scan,
 * and a browser cannot scan (`gloveSupport.ts`).
 */
import React from 'react'
import { Platform } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'

const mockArm = jest.fn(async () => ({ outcomes: [], connectedCount: 0 }))
jest.mock('@ble/autoConnectTrackers', () => ({
  AUTO_RETRY_BUDGET: 5,
  armAutoRetry: () => mockArm(),
  isAutoConnectInFlight: () => false,
  getAutoRetryState: () => ({ attemptsLeft: 5, retrying: false, exhausted: false }),
  subscribeAutoRetry: () => () => undefined,
}))

import { ConnectTrackersButton } from '../ConnectTrackersButton'

let restoreOs: { restore: () => void } | null = null
let tree: ReactTestRenderer | null = null

function render(os: typeof Platform.OS): ReactTestRenderer {
  restoreOs = jest.replaceProperty(Platform, 'OS', os)
  act(() => {
    tree = create(<ConnectTrackersButton />)
  })
  return tree as ReactTestRenderer
}

beforeEach(() => mockArm.mockClear())
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  restoreOs?.restore()
  restoreOs = null
})

describe('ConnectTrackersButton', () => {
  it('on the tablet, is there and starts a connect pass when pressed', async () => {
    const t = render('android')
    await act(async () => {
      t.root.findByProps({ testID: 'connect-trackers' }).props.onPress()
    })
    expect(mockArm).toHaveBeenCalledTimes(1)
  })

  it('in a browser, renders nothing at all', () => {
    const t = render('web')
    expect(t.toJSON()).toBeNull()
    expect(t.root.findAllByProps({ testID: 'connect-trackers' })).toHaveLength(0)
  })
})
