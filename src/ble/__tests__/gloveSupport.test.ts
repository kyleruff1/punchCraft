/**
 * Where the build cannot search for gloves (a browser), nothing tries:
 * no permission prompt, no scan, no retry chain — and the caller is told why.
 */
import { Platform } from 'react-native'

const mockScan = jest.fn()
const mockIsDeviceConnected = jest.fn()
jest.mock('@ble/TrackerCoordinator', () => ({
  getTrackerCoordinator: () => ({
    scan: (...a: unknown[]) => mockScan(...a),
    connectSlot: jest.fn(),
    disconnectSlot: jest.fn(),
    evictSlot: jest.fn(),
    isDeviceConnected: (...a: unknown[]) => mockIsDeviceConnected(...a),
  }),
}))
const mockPermissionCurrent = jest.fn()
jest.mock('@ble/PermissionService', () => ({
  PermissionService: {
    current: () => mockPermissionCurrent(),
    request: jest.fn(),
  },
}))
jest.mock('@state/useTrackerStore', () => ({
  getTrackerSlots: () => ({ left: null, right: null }),
}))

import {
  armAutoRetry,
  autoConnectKnownTrackers,
  getAutoRetryState,
  resetAutoRetryForTest,
  RETRY_DELAY_MS,
} from '../autoConnectTrackers'
import { canFindGloves, NO_GLOVE_SEARCH_MESSAGE } from '../gloveSupport'

let restoreOs: { restore: () => void }
const on = (os: typeof Platform.OS): void => {
  restoreOs?.restore()
  restoreOs = jest.replaceProperty(Platform, 'OS', os)
}

beforeEach(() => {
  jest.useFakeTimers()
  mockScan.mockReset().mockResolvedValue([])
  mockIsDeviceConnected.mockReset().mockResolvedValue(false)
  mockPermissionCurrent.mockReset().mockResolvedValue({ granted: true })
  resetAutoRetryForTest()
})
afterEach(() => {
  restoreOs?.restore()
  jest.useRealTimers()
})

describe('canFindGloves', () => {
  it('is true on the tablet and false in a browser', () => {
    on('android')
    expect(canFindGloves()).toBe(true)
    on('web')
    expect(canFindGloves()).toBe(false)
  })
})

describe('in a browser', () => {
  beforeEach(() => on('web'))

  it('a connect pass answers at once: nothing asked, nothing scanned', async () => {
    const result = await autoConnectKnownTrackers()
    expect(result).toEqual({ outcomes: [], connectedCount: 0, scanError: NO_GLOVE_SEARCH_MESSAGE })
    expect(mockPermissionCurrent).not.toHaveBeenCalled()
    expect(mockScan).not.toHaveBeenCalled()
  })

  it('arming the retry chain arms nothing', async () => {
    const before = getAutoRetryState()
    const result = await armAutoRetry()
    expect(result.scanError).toBe(NO_GLOVE_SEARCH_MESSAGE)
    expect(getAutoRetryState()).toEqual(before)

    await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS * 10)
    expect(mockScan).not.toHaveBeenCalled()
  })
})

describe('on the tablet', () => {
  beforeEach(() => on('android'))

  it('a pass still asks for permission and scans', async () => {
    await autoConnectKnownTrackers()
    expect(mockPermissionCurrent).toHaveBeenCalledTimes(1)
    expect(mockScan).toHaveBeenCalledTimes(1)
  })
})
