/**
 * PunchStream's init plan, and the one way to opt out of its writes.
 *
 * Runs the REAL FightCamp v1 plan against a recording facade — no radio, no
 * BLE library — so what is asserted is the sequence a glove would actually
 * receive.
 *
 * Why the opt-out exists: the app-wide keepalive initialises a glove the
 * moment it connects and keeps a stream on it. Velocity Lab Live then
 * started a stream of its own and ran the whole plan again, clock sync
 * first — re-basing the tracker's timestamps under the stream that was
 * already decoding them.
 */
import type { BleManagerFacade, SubscriptionHandle } from '@ble/BleManagerFacade'
import type { GattSnapshot } from '@ble/bleTypes'
import { replaceSinks } from '@diagnostics/logger'
import { FightCampV1Adapter } from '@protocol/fightcamp-v1'
import { startPunchStream } from '@protocol/PunchStream'

const DEVICE = 'D7:34:B4:27:D5:84'

beforeAll(() => {
  replaceSinks([])
})

interface Recorded {
  kind: 'subscribe' | 'read' | 'write'
  characteristicUuid: string
}

function recordingFacade(): {
  facade: BleManagerFacade
  ops: Recorded[]
  unsubscribes: () => number
} {
  const ops: Recorded[] = []
  let unsubscribed = 0
  const snapshot: GattSnapshot = { deviceId: DEVICE, services: [], discoveredAtMonotonicMs: 0 }
  const facade = {
    discoverAllServicesAndCharacteristics: () => Promise.resolve(snapshot),
    monitorCharacteristic: (_d: string, _s: string, characteristicUuid: string) => {
      ops.push({ kind: 'subscribe', characteristicUuid })
      const result = { success: true }
      const handle = {
        result,
        setupOutcome: Promise.resolve(result),
        unsubscribe: () => {
          unsubscribed += 1
        },
      } as unknown as SubscriptionHandle
      return Promise.resolve(handle)
    },
    readCharacteristic: (_d: string, _s: string, characteristicUuid: string) => {
      ops.push({ kind: 'read', characteristicUuid })
      return Promise.resolve({ success: true, valueHex: '01' })
    },
    writeCharacteristic: (_d: string, _s: string, characteristicUuid: string) => {
      ops.push({ kind: 'write', characteristicUuid })
      return Promise.resolve({ success: true, durationMs: 1 })
    },
  } as unknown as BleManagerFacade
  return { facade, ops, unsubscribes: () => unsubscribed }
}

const start = (facade: BleManagerFacade, initialize?: boolean) =>
  startPunchStream({
    facade,
    deviceId: DEVICE,
    adapter: new FightCampV1Adapter(),
    hand: 'left',
    onEvent: () => {},
    ...(initialize === undefined ? {} : { initialize }),
  })

describe('the init plan', () => {
  it('runs in full by default: clock sync first, then subscribes, read and the mode writes', async () => {
    const { facade, ops } = recordingFacade()
    const stream = await start(facade)

    expect(ops.map((op) => op.kind)).toEqual([
      'write', // clock sync
      'subscribe',
      'subscribe',
      'subscribe',
      'read',
      'write', // mode normal
      'write', // hand assignment
      'write', // command 17
    ])
    expect(stream.getState().subscribedCount).toBe(3)
    expect(stream.getState().initErrors).toEqual([])
  })

  it('treats initialize: true as the default', async () => {
    const byDefault = recordingFacade()
    const explicit = recordingFacade()
    await start(byDefault.facade)
    await start(explicit.facade, true)
    expect(explicit.ops).toEqual(byDefault.ops)
  })
})

describe('attaching to a glove that is already initialised', () => {
  it('sends no write at all', async () => {
    const { facade, ops } = recordingFacade()
    await start(facade, false)
    expect(ops.filter((op) => op.kind === 'write')).toEqual([])
  })

  it('still subscribes to every characteristic and reads device info', async () => {
    const full = recordingFacade()
    const attached = recordingFacade()
    await start(full.facade)
    const stream = await start(attached.facade, false)

    const listening = (ops: Recorded[]): Recorded[] => ops.filter((op) => op.kind !== 'write')
    expect(attached.ops).toEqual(listening(full.ops))
    expect(stream.getState().subscribedCount).toBe(3)
    expect(Object.keys(stream.getState().deviceInfo)).toHaveLength(1)
    expect(stream.getState().initErrors).toEqual([])
  })

  it('releases its subscriptions on stop, like any other stream', async () => {
    const { facade, unsubscribes } = recordingFacade()
    const stream = await start(facade, false)
    await stream.stop()
    expect(unsubscribes()).toBe(3)
  })
})
