/**
 * The "keep raw glove data" setting (N-7): on unless a stored literal `false`
 * says otherwise, and what switching it does.
 */
const mockStartAmbient = jest.fn(() => true)
const mockStopAmbient = jest.fn(async () => undefined)
jest.mock('@capture/getCaptureService', () => ({
  startAmbientCapture: () => mockStartAmbient(),
  stopAmbientCapture: () => mockStopAmbient(),
}))

let mockOpenThrows = false
let mockStored: Record<string, unknown> | null = null
const mockWrites: Array<{ key: string; value: unknown }> = []
jest.mock('@storage/database', () => ({
  openDatabase: () => {
    if (mockOpenThrows) throw new Error('database unavailable')
    return {}
  },
}))
jest.mock('@storage/repositories/SettingsRepository', () => ({
  SettingsRepository: class {
    readChecked<T>(_key: string, normalize: (stored: Record<string, unknown>) => T) {
      return { value: normalize(mockStored ?? {}), corrected: false }
    }
    write(key: string, value: unknown) {
      mockWrites.push({ key, value })
    }
  },
}))

import { SETTINGS_KEYS } from '@storage/migrations/006_app_settings'
import { SettingsRepository } from '@storage/repositories/SettingsRepository'

import {
  __resetCaptureSettingsLoadForTests,
  startKeepingRawFramesOnce,
} from '../loadCaptureSettings'
import { __resetCaptureSettingsForTests, useCaptureSettingsStore } from '../useCaptureSettingsStore'

const store = () => useCaptureSettingsStore.getState()
const load = (stored: Record<string, unknown> | null): boolean => {
  mockStored = stored
  store().load(new SettingsRepository({} as never))
  return store().keepRawFrames
}

beforeEach(() => {
  mockStartAmbient.mockClear()
  mockStopAmbient.mockClear()
  mockWrites.length = 0
  mockStored = null
  mockOpenThrows = false
  __resetCaptureSettingsForTests()
  __resetCaptureSettingsLoadForTests()
})

describe('the stored setting', () => {
  it('is on with nothing stored — keeping raw frames is the rule, not an option taken', () => {
    expect(store().keepRawFrames).toBe(true)
    expect(load(null)).toBe(true)
  })

  it('is off only for a stored literal false', () => {
    expect(load({ keepRawFrames: false })).toBe(false)
  })

  it.each([['false'], [0], [null], [undefined], ['no'], [{}]])(
    'stays on for a damaged value: %p',
    (value) => {
      expect(load({ keepRawFrames: value })).toBe(true)
    },
  )
})

describe('switching it', () => {
  it('off: stops the ambient capture and remembers', () => {
    load(null)
    store().setKeepRawFrames(false)
    expect(mockStopAmbient).toHaveBeenCalledTimes(1)
    expect(mockStartAmbient).not.toHaveBeenCalled()
    expect(mockWrites).toEqual([{ key: SETTINGS_KEYS.capture, value: { keepRawFrames: false } }])
  })

  it('on: starts it again and remembers', () => {
    load({ keepRawFrames: false })
    store().setKeepRawFrames(true)
    expect(mockStartAmbient).toHaveBeenCalledTimes(1)
    expect(mockWrites).toEqual([{ key: SETTINGS_KEYS.capture, value: { keepRawFrames: true } }])
  })
})

describe('at launch', () => {
  it('starts keeping frames, once', () => {
    startKeepingRawFramesOnce()
    startKeepingRawFramesOnce()
    expect(mockStartAmbient).toHaveBeenCalledTimes(1)
  })

  it('does not, when it has been switched off', () => {
    mockStored = { keepRawFrames: false }
    startKeepingRawFramesOnce()
    expect(mockStartAmbient).not.toHaveBeenCalled()
    expect(store().keepRawFrames).toBe(false)
  })

  it('still starts when the settings cannot be read, and does not throw', () => {
    mockOpenThrows = true
    expect(() => startKeepingRawFramesOnce()).not.toThrow()
    expect(mockStartAmbient).toHaveBeenCalledTimes(1)
  })
})
