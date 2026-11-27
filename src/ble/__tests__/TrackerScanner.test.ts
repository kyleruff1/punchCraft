/**
 * TrackerScanner — a bounded scan over the transport facade.
 *
 * The file had no tests until N-9: a scan that THREW (rather than rejected)
 * left the stop timer armed, and it fired ten seconds later into a transport
 * that could not answer. That is pinned here, with the behaviour around it.
 */
import type { BleManagerFacade, ScanOptions } from '../BleManagerFacade'
import type { AdvertisementSnapshot } from '../bleTypes'
import { TrackerScanner } from '../TrackerScanner'

type OnAd = (ad: AdvertisementSnapshot) => void

const ad = (deviceId: string, at: number, over: Partial<AdvertisementSnapshot> = {}) =>
  ({
    deviceId,
    serviceUuids: [],
    monotonicTimeMs: at,
    wallTimeIso: '2026-11-26T00:00:00.000Z',
    ...over,
  }) as AdvertisementSnapshot

/** A transport whose scan runs until `stopScan()` is called, as the real one does. */
function scanningFacade() {
  let finish: (() => void) | null = null
  let deliver: OnAd | null = null
  const stopScan = jest.fn(async () => {
    finish?.()
    finish = null
  })
  const scan = jest.fn(
    (_options: ScanOptions, onAdvertisement: OnAd) =>
      new Promise<void>((resolve) => {
        deliver = onAdvertisement
        finish = resolve
      }),
  )
  return {
    facade: { scan, stopScan } as unknown as BleManagerFacade,
    scan,
    stopScan,
    advertise: (snapshot: AdvertisementSnapshot) => deliver?.(snapshot),
  }
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe('a scan that runs', () => {
  it('stops at the timeout and returns what it saw, newest first', async () => {
    const t = scanningFacade()
    const run = new TrackerScanner(t.facade).run({ timeoutMs: 5_000 })
    t.advertise(ad('A', 10))
    t.advertise(ad('B', 20))

    await jest.advanceTimersByTimeAsync(4_999)
    expect(t.stopScan).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)

    expect((await run).map((a) => a.deviceId)).toEqual(['B', 'A'])
    expect(jest.getTimerCount()).toBe(0)
  })

  it('stops early once enough devices have been seen', async () => {
    const t = scanningFacade()
    const run = new TrackerScanner(t.facade).run({ timeoutMs: 5_000, stopAfterDevices: 2 })
    t.advertise(ad('A', 10))
    expect(t.stopScan).not.toHaveBeenCalled()
    t.advertise(ad('B', 20))

    expect(await run).toHaveLength(2)
    // The timeout it no longer needs is gone, not left to fire later.
    expect(jest.getTimerCount()).toBe(0)
  })

  it('keeps one entry per device: the newest reading, and data a later frame left out', async () => {
    const t = scanningFacade()
    const run = new TrackerScanner(t.facade).run({ timeoutMs: 1_000 })
    t.advertise(ad('A', 10, { rssi: -70, name: 'FightCam', manufacturerDataBase64: 'AQI=' }))
    t.advertise(ad('A', 30, { rssi: -55 }))
    await jest.advanceTimersByTimeAsync(1_000)

    expect(await run).toEqual([
      expect.objectContaining({
        deviceId: 'A',
        rssi: -55,
        name: 'FightCam',
        manufacturerDataBase64: 'AQI=',
        monotonicTimeMs: 30,
      }),
    ])
  })
})

describe('a scan that fails', () => {
  it('yields nothing rather than an error when the scan rejects', async () => {
    const stopScan = jest.fn(async () => undefined)
    const facade = {
      scan: jest.fn(() => Promise.reject(new Error('bluetooth off'))),
      stopScan,
    } as unknown as BleManagerFacade

    await expect(new TrackerScanner(facade).run({ timeoutMs: 5_000 })).resolves.toEqual([])
    expect(stopScan).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('yields nothing, and leaves no timer, when the scan THROWS (N-9)', async () => {
    const facade = {
      scan: jest.fn(() => {
        throw new TypeError('this.facade.scan is not a function')
      }),
      stopScan: jest.fn(async () => undefined),
    } as unknown as BleManagerFacade

    await expect(new TrackerScanner(facade).run({ timeoutMs: 5_000 })).resolves.toEqual([])
    expect(jest.getTimerCount()).toBe(0)
  })

  it('survives a transport with neither method — the test double that exposed N-9', async () => {
    const facade = {} as unknown as BleManagerFacade

    await expect(new TrackerScanner(facade).run({ timeoutMs: 5_000 })).resolves.toEqual([])
    // Ten seconds on, nothing fires into the missing `stopScan`.
    expect(() => jest.advanceTimersByTime(60_000)).not.toThrow()
    expect(jest.getTimerCount()).toBe(0)
  })
})
