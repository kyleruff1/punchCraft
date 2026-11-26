/**
 * Keeping raw frames for the whole connection (N-7), against a real
 * in-memory database and the transport's two capture hooks.
 *
 * `BleCaptureService.test.ts` covers the service on fakes. This is the wiring
 * around it: what is on the transport and when, what a second launch does to
 * the first one's capture, and what pruning may and may not delete.
 */
import type { BleManagerFacade } from '@ble/BleManagerFacade'
import { registerBleManagerFactory, resetBleManagerSingleton } from '@ble/BleManagerFacade'
import type { RawBleFrame, RawFrameSink } from '@ble/bleTypes'
import { addSink, replaceSinks } from '@diagnostics/logger'
import { createMigratedDb, type MemoryDb } from '@storage/__tests__/helpers/memoryDb'

import {
  __resetCaptureServiceForTests,
  startAmbientCapture,
  startCapture,
  stopAmbientCapture,
  stopCapture,
} from '../getCaptureService'

let mockDb: MemoryDb | null = null
let mockOpenFails = false
jest.mock('@storage/database', () => ({
  openDatabase: () => {
    if (mockOpenFails || !mockDb) throw new Error('database unavailable')
    return mockDb
  },
}))

const NOW = Date.parse('2026-11-26T12:00:00.000Z')

let sink: RawFrameSink | null = null
let captureIdOf: () => string = () => 'ephemeral'
let seq = 0

/** A frame arriving on the transport: stamped with the current capture id, sink first. */
function arrive(characteristicUuid = 'ca281069', wallTimeIso = '2026-11-26T12:00:01.000Z'): string {
  const captureId = captureIdOf()
  const frame: RawBleFrame = {
    id: `${captureId}-${seq++}`,
    captureId,
    deviceId: 'EA:69:2D:9C:FD:53',
    handAtCapture: 'unknown',
    monotonicTimeMs: seq,
    wallTimeIso,
    direction: 'indication',
    serviceUuid: 'ca280069',
    characteristicUuid,
    valueBase64: 'AQ==',
    valueHex: '01',
    connectionGeneration: 1,
  }
  sink?.capture(frame)
  return frame.id
}

const captures = () =>
  mockDb!.query<{ id: string; label: string | null; ended_at: string | null }>(
    'SELECT id, label, ended_at FROM ble_captures ORDER BY started_at, id',
  )
const framesIn = (captureId: string): number =>
  mockDb!.query<{ n: number }>('SELECT COUNT(*) AS n FROM ble_frames WHERE capture_id = ?', [
    captureId,
  ])[0]!.n

beforeEach(() => {
  mockDb = createMigratedDb()
  mockOpenFails = false
  sink = null
  captureIdOf = () => 'ephemeral'
  seq = 0
  resetBleManagerSingleton()
  registerBleManagerFactory(
    () =>
      ({
        setFrameSink: (next: RawFrameSink | null) => {
          sink = next
        },
        setCaptureIdProvider: (provider: () => string) => {
          captureIdOf = provider
        },
      }) as unknown as BleManagerFacade,
  )
  __resetCaptureServiceForTests()
})

afterEach(async () => {
  await stopCapture()
  await stopAmbientCapture()
  replaceSinks([])
  mockDb?.close()
  mockDb = null
})

describe('with the ambient capture open', () => {
  it('stores a frame that arrives with no Velocity Lab capture open', async () => {
    expect(startAmbientCapture(NOW)).toBe(true)
    expect(sink).not.toBeNull()
    arrive()
    arrive()
    await stopAmbientCapture()

    const [ambient] = captures()
    expect(ambient).toMatchObject({ label: 'connection' })
    expect(framesIn(ambient!.id)).toBe(2)
  })

  it('gives a Velocity Lab capture its own frames, then takes them back', async () => {
    startAmbientCapture(NOW)
    arrive()
    startCapture('live-decode')
    arrive()
    arrive()
    await stopCapture()
    // Still on the transport: stopping a labelled capture used to remove it.
    expect(sink).not.toBeNull()
    arrive()
    await stopAmbientCapture()

    const rows = captures()
    const count = (label: string) => framesIn(rows.find((r) => r.label === label)!.id)
    expect(count('connection')).toBe(2)
    expect(count('live-decode')).toBe(2)
  })

  it('comes off the transport when switched off, unless a labelled capture wants it', async () => {
    startAmbientCapture(NOW)
    await stopAmbientCapture()
    expect(sink).toBeNull()
    expect(captureIdOf()).toBe('ephemeral')

    startAmbientCapture(NOW)
    startCapture('live-decode')
    await stopAmbientCapture()
    expect(sink).not.toBeNull()
  })
})

describe('without it (switched off)', () => {
  it('leaves Velocity Lab exactly as it was: on at start, off at stop', async () => {
    startCapture('live-decode')
    expect(sink).not.toBeNull()
    arrive()
    await stopCapture()
    expect(sink).toBeNull()
    expect(captures().map((c) => c.label)).toEqual(['live-decode'])
  })

  it('keeps the sink for a capture that started while the last one was stopping', async () => {
    // A screen's effect cleanup fires stop() without awaiting it, and the next
    // effect starts a capture at once. The late stop must not take the sink.
    startCapture('first')
    const stopping = stopCapture()
    startCapture('second')
    await stopping
    expect(sink).not.toBeNull()
  })
})

describe('the next launch', () => {
  // Fake timers: a relaunch here abandons the first service with its flush
  // interval still armed — as a killed app does — and a real interval would
  // keep the test run alive for ever.
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  /** What a relaunch is to this module: the service is gone, the database is not. */
  const relaunch = (): void => {
    __resetCaptureServiceForTests()
    sink = null
  }
  /** Let the frame buffer's latency flush run. */
  const flush = (): Promise<void> => jest.advanceTimersByTimeAsync(1_200)

  it('closes the capture the last launch left open, at its last frame, and logs what it held', async () => {
    startAmbientCapture(NOW)
    arrive('ca281069', '2026-11-26T12:00:05.000Z')
    arrive('ca281073', '2026-11-26T12:00:09.000Z')
    arrive('ca281073', '2026-11-26T12:00:07.000Z')
    // Flush, but do NOT close: the app was killed.
    const first = captures()[0]!
    await flush()
    expect(first.ended_at).toBeNull()

    const logged: Array<Record<string, unknown>> = []
    addSink({
      write: (r) => {
        if (r.code !== 'capture.ambient.previous') return
        logged.push(Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, f.value])))
      },
    })
    relaunch()
    startAmbientCapture(NOW + 60_000)

    const rows = captures()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === first.id)?.ended_at).toBe('2026-11-26T12:00:09.000Z')
    expect(logged).toEqual([
      {
        captureId: first.id,
        startedAt: expect.any(String),
        frames: 3,
        byCharacteristic: JSON.stringify({ ca281069: 1, ca281073: 2 }),
      },
    ])
  })

  it('deletes an ambient capture past the retention, frames and all, and nothing else', async () => {
    const old = '2026-05-01T00:00:00.000Z' // about 209 days before NOW
    const insertCapture = (id: string, label: string): void => {
      mockDb!
        .prepareSync(
          'INSERT INTO ble_captures (id, label, started_at, ended_at) VALUES (?, ?, ?, ?)',
        )
        .executeSync([id, label, old, old])
      mockDb!
        .prepareSync(
          `INSERT INTO ble_frames
             (id, capture_id, monotonic_time_ms, wall_time_iso, direction, service_uuid,
              characteristic_uuid, value_base64, value_hex, connection_generation)
           VALUES (?, ?, 1, ?, 'indication', 's', 'c', 'AQ==', '01', 1)`,
        )
        .executeSync([`${id}-f`, id, old])
    }
    insertCapture('old-ambient', 'connection')
    insertCapture('old-velocity-lab', 'live-decode')

    startAmbientCapture(NOW)

    expect(captures().map((c) => c.id)).not.toContain('old-ambient')
    expect(framesIn('old-ambient')).toBe(0)
    // A capture someone opened on purpose is never pruned, however old.
    expect(framesIn('old-velocity-lab')).toBe(1)
  })

  it('opens one ambient capture per launch', () => {
    startAmbientCapture(NOW)
    startAmbientCapture(NOW)
    expect(captures().filter((c) => c.label === 'connection')).toHaveLength(1)
    relaunch()
    startAmbientCapture(NOW)
    expect(captures().filter((c) => c.label === 'connection')).toHaveLength(2)
  })
})

describe('when storage is unavailable', () => {
  it('reports that frames are not being kept, and does not throw', () => {
    mockOpenFails = true
    expect(startAmbientCapture(NOW)).toBe(false)
    expect(sink).toBeNull()
  })
})
