/**
 * The root layout's storage gate: ready at once on the tablet, awaited in a
 * browser, and a stated reason when storage cannot be had.
 */
let mockReady = true
let mockPrepare: jest.Mock<Promise<void>, []>
jest.mock('@storage/database', () => ({
  isStorageReady: () => mockReady,
  prepareStorage: () => mockPrepare(),
}))

import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'

import { replaceSinks, type LogRecord } from '@diagnostics/logger'
import { StorageNotice } from '@storage/storageNotice'

import { STORAGE_FAULT, useStorageReady, type StorageStatus } from '../useStorageReady'

const seen: StorageStatus[] = []
function Probe(): null {
  seen.push(useStorageReady())
  return null
}

let records: LogRecord[]
beforeEach(() => {
  seen.length = 0
  records = []
  replaceSinks([{ write: (r) => records.push(r) }])
  mockPrepare = jest.fn(() => Promise.resolve())
})
afterEach(() => replaceSinks([]))

describe('on the tablet, where storage is ready when asked', () => {
  it('is ready on the very first render, and prepares nothing', () => {
    mockReady = true
    act(() => {
      create(<Probe />)
    })
    expect(seen).toEqual([{ state: 'ready' }])
    expect(mockPrepare).not.toHaveBeenCalled()
  })
})

describe('in a browser, where storage has to load', () => {
  let resolve: () => void
  let reject: (err: Error) => void
  beforeEach(() => {
    mockReady = false
    mockPrepare = jest.fn(
      () =>
        new Promise<void>((res, rej) => {
          resolve = res
          reject = rej
        }),
    )
  })

  it('is loading until the database is prepared, then ready', async () => {
    act(() => {
      create(<Probe />)
    })
    expect(seen.at(-1)).toEqual({ state: 'loading' })
    expect(mockPrepare).toHaveBeenCalledTimes(1)

    await act(async () => resolve())
    expect(seen.at(-1)).toEqual({ state: 'ready' })
    expect(mockPrepare).toHaveBeenCalledTimes(1)
  })

  it('says a fault plainly, and logs the detail, when the engine does not load', async () => {
    act(() => {
      create(<Probe />)
    })
    await act(async () => reject(new Error('wasm 404')))
    expect(seen.at(-1)).toEqual({ state: 'failed', reason: STORAGE_FAULT })
    expect(records.map((r) => r.code)).toContain('storage.prepareFailed')
  })

  it('shows a notice in its own words — and does not log it as a fault', async () => {
    act(() => {
      create(<Probe />)
    })
    await act(async () => reject(new StorageNotice('Already open in another tab.')))
    expect(seen.at(-1)).toEqual({ state: 'failed', reason: 'Already open in another tab.' })
    expect(records.map((r) => r.code)).not.toContain('storage.prepareFailed')
  })

  it('leaves an unmounted layout alone', async () => {
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<Probe />)
    })
    act(() => tree.unmount())
    const rendersBefore = seen.length
    await act(async () => resolve())
    expect(seen).toHaveLength(rendersBefore)
  })
})
