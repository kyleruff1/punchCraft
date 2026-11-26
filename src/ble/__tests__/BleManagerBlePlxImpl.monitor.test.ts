/**
 * Shared characteristic monitors (the "Velocity Lab silences the gloves" bug).
 *
 * The app-wide keepalive holds each glove's punch characteristic for the
 * app's whole life. The Velocity Lab screens subscribe to the same one. The
 * transport used to keep a single unowned slot per characteristic, so:
 *
 * - a second subscriber REMOVED the incumbent's native monitor and took the
 *   slot — opening Velocity Lab killed the keepalive's stream, which only
 *   re-arms on a connection change; and
 * - any handle's `unsubscribe()` removed whoever held the slot at that
 *   moment — so a handle left over from before a reconnect tore down the
 *   monitor that replaced it.
 *
 * Either way every later workout counted zero punches with both glove lamps
 * lit and nothing logged. These tests pin the replacement: one native
 * monitor per characteristic, many listeners, each handle its own.
 *
 * No Bluetooth here — the BLE library is replaced by a fake that records
 * each native monitor and lets a test fire its callback. What this cannot
 * show is how the real stack behaves; that is checked on the tablet.
 */
import { BleManagerBlePlxImpl } from '../BleManagerBlePlxImpl'
import type { GattSnapshot, RawBleFrame, RawFrameSink } from '../bleTypes'

type MonitorCallback = (err: { message: string } | null, characteristic: unknown) => void

interface FakeMonitor {
  characteristicUuid: string
  callback: MonitorCallback
  remove: jest.Mock
}

/** Every native monitor the fake library was asked for, in order. */
const mockMonitors: FakeMonitor[] = []
/** When set, the next native monitor fails inside the call that creates it. */
let mockFailNextMonitorWith: string | null = null

jest.mock('@sfourdrinier/react-native-ble-plx', () => {
  class BleManager {
    async characteristicsForDevice(): Promise<unknown[]> {
      return []
    }
    monitorCharacteristicForDevice(
      _deviceId: string,
      _serviceUuid: string,
      characteristicUuid: string,
      callback: MonitorCallback,
    ): { remove: jest.Mock } {
      const monitor: FakeMonitor = { characteristicUuid, callback, remove: jest.fn() }
      mockMonitors.push(monitor)
      if (mockFailNextMonitorWith !== null) {
        const message = mockFailNextMonitorWith
        mockFailNextMonitorWith = null
        callback({ message }, null)
      }
      return { remove: monitor.remove }
    }
    async connectToDevice(deviceId: string): Promise<{ id: string }> {
      return { id: deviceId }
    }
    async requestConnectionPriorityForDevice(): Promise<void> {}
    onDeviceDisconnected(): { remove: jest.Mock } {
      return { remove: jest.fn() }
    }
    async stopDeviceScan(): Promise<void> {}
    destroy(): void {}
  }
  return { BleManager, ConnectionPriority: { Balanced: 0, High: 1, LowPower: 2 } }
})

const GLOVE = 'D7:34:B4:27:D5:84'
const SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb'
const PUNCHES = '0000fff1-0000-1000-8000-00805f9b34fb'
const OTHER = '0000fff2-0000-1000-8000-00805f9b34fb'

/** Bytes 01 02 03. */
const PAYLOAD = 'AQID'

function harness() {
  const ble = new BleManagerBlePlxImpl()
  const captured: RawBleFrame[] = []
  /** What happened, in order — to show the sink is ahead of every listener. */
  const order: string[] = []
  const sink: RawFrameSink = {
    capture: (frame) => {
      captured.push(frame)
      order.push('sink')
    },
  }
  ble.setFrameSink(sink)

  const owner = (name: string) => {
    const frames: RawBleFrame[] = []
    const onFrame = (frame: RawBleFrame): void => {
      frames.push(frame)
      order.push(name)
    }
    return { frames, onFrame }
  }

  const subscribe = (onFrame: (frame: RawBleFrame) => void, characteristic = PUNCHES) =>
    ble.monitorCharacteristic(GLOVE, SERVICE, characteristic, onFrame)

  return { ble, captured, order, owner, subscribe }
}

/** Fire a notification on a native monitor, as the library would. */
const notify = (monitor: FakeMonitor): void => {
  monitor.callback(null, { value: PAYLOAD, isNotifiable: true, isIndicatable: false })
}

const monitorAt = (index: number): FakeMonitor => {
  const monitor = mockMonitors[index]
  if (!monitor) throw new Error(`no native monitor #${index}`)
  return monitor
}

beforeEach(() => {
  jest.useFakeTimers()
  mockMonitors.length = 0
  mockFailNextMonitorWith = null
})

afterEach(() => {
  jest.useRealTimers()
})

// ---------------------------------------------------------------------------

describe('a characteristic two owners both want', () => {
  it('gets one native monitor, however many owners subscribe', async () => {
    const h = harness()
    await h.subscribe(h.owner('keepalive').onFrame)
    await h.subscribe(h.owner('lab').onFrame)
    await h.subscribe(h.owner('probe').onFrame)
    expect(mockMonitors).toHaveLength(1)
    // Nobody was evicted to make room.
    expect(monitorAt(0).remove).not.toHaveBeenCalled()
  })

  it('delivers each frame to every owner', async () => {
    const h = harness()
    const keepalive = h.owner('keepalive')
    const lab = h.owner('lab')
    await h.subscribe(keepalive.onFrame)
    await h.subscribe(lab.onFrame)

    notify(monitorAt(0))
    expect(keepalive.frames).toHaveLength(1)
    expect(lab.frames).toHaveLength(1)
    expect(lab.frames[0]).toBe(keepalive.frames[0])
  })

  it('persists each frame once, before any owner hears it', async () => {
    // CLAUDE.md rule 1. Two native monitors on one characteristic would have
    // written every frame twice.
    const h = harness()
    await h.subscribe(h.owner('keepalive').onFrame)
    await h.subscribe(h.owner('lab').onFrame)

    notify(monitorAt(0))
    expect(h.captured).toHaveLength(1)
    expect(h.order).toEqual(['sink', 'keepalive', 'lab'])
  })

  it('keeps the first owner streaming when the second one leaves', async () => {
    // The bug as it happened: gloves connected, open Velocity Lab, go back.
    const h = harness()
    const keepalive = h.owner('keepalive')
    await h.subscribe(keepalive.onFrame)
    const lab = await h.subscribe(h.owner('lab').onFrame)

    lab.unsubscribe()
    expect(monitorAt(0).remove).not.toHaveBeenCalled()

    notify(monitorAt(0))
    expect(keepalive.frames).toHaveLength(1)
  })

  it('keeps the second owner streaming when the first one leaves', async () => {
    const h = harness()
    const first = await h.subscribe(h.owner('first').onFrame)
    const second = h.owner('second')
    await h.subscribe(second.onFrame)

    first.unsubscribe()
    expect(monitorAt(0).remove).not.toHaveBeenCalled()

    notify(monitorAt(0))
    expect(second.frames).toHaveLength(1)
  })

  it('stops delivering to an owner that has left', async () => {
    const h = harness()
    await h.subscribe(h.owner('keepalive').onFrame)
    const lab = h.owner('lab')
    const handle = await h.subscribe(lab.onFrame)

    handle.unsubscribe()
    notify(monitorAt(0))
    expect(lab.frames).toHaveLength(0)
  })

  it('removes the native monitor only when the last owner leaves', async () => {
    const h = harness()
    const a = await h.subscribe(h.owner('a').onFrame)
    const b = await h.subscribe(h.owner('b').onFrame)

    a.unsubscribe()
    expect(monitorAt(0).remove).not.toHaveBeenCalled()
    b.unsubscribe()
    expect(monitorAt(0).remove).toHaveBeenCalledTimes(1)
  })

  it('installs a fresh native monitor once everyone has left', async () => {
    const h = harness()
    const a = await h.subscribe(h.owner('a').onFrame)
    a.unsubscribe()

    const again = h.owner('again')
    await h.subscribe(again.onFrame)
    expect(mockMonitors).toHaveLength(2)
    notify(monitorAt(1))
    expect(again.frames).toHaveLength(1)
  })

  it('treats a second unsubscribe from the same handle as nothing', async () => {
    const h = harness()
    const keepalive = h.owner('keepalive')
    await h.subscribe(keepalive.onFrame)
    const lab = await h.subscribe(h.owner('lab').onFrame)

    lab.unsubscribe()
    lab.unsubscribe()
    lab.unsubscribe()
    expect(monitorAt(0).remove).not.toHaveBeenCalled()
    notify(monitorAt(0))
    expect(keepalive.frames).toHaveLength(1)
  })

  it('gives two owners that pass the same function two memberships', async () => {
    const h = harness()
    const shared = h.owner('shared')
    const one = await h.subscribe(shared.onFrame)
    await h.subscribe(shared.onFrame)

    one.unsubscribe()
    notify(monitorAt(0))
    // The other membership is intact — and it is one delivery, not two.
    expect(shared.frames).toHaveLength(1)
  })

  it('keeps separate characteristics separate', async () => {
    const h = harness()
    const punches = h.owner('punches')
    const other = h.owner('other')
    await h.subscribe(punches.onFrame, PUNCHES)
    const otherHandle = await h.subscribe(other.onFrame, OTHER)
    expect(mockMonitors).toHaveLength(2)

    otherHandle.unsubscribe()
    expect(monitorAt(0).remove).not.toHaveBeenCalled()
    notify(monitorAt(0))
    expect(punches.frames).toHaveLength(1)
    expect(other.frames).toHaveLength(0)
  })

  it('lets a subscribe-everything pass join without evicting the keepalive', async () => {
    // The Probe screen: `monitorAllNotifiable` over the whole GATT table,
    // which includes the characteristic the keepalive already holds.
    const h = harness()
    const keepalive = h.owner('keepalive')
    await h.subscribe(keepalive.onFrame)

    const snapshot = {
      deviceId: GLOVE,
      discoveredAtMonotonicMs: 0,
      services: [
        {
          uuid: SERVICE,
          characteristics: [
            { uuid: PUNCHES, properties: { notify: true, indicate: false } },
            { uuid: OTHER, properties: { notify: true, indicate: false } },
          ],
        },
      ],
    } as unknown as GattSnapshot
    const handles = await h.ble.monitorAllNotifiable(snapshot, h.owner('probe').onFrame)

    // One new native monitor, for the characteristic nobody held yet.
    expect(mockMonitors.map((m) => m.characteristicUuid)).toEqual([PUNCHES, OTHER])

    for (const handle of handles) handle.unsubscribe()
    expect(monitorAt(0).remove).not.toHaveBeenCalled()
    notify(monitorAt(0))
    expect(keepalive.frames).toHaveLength(1)
  })
})

describe('the setup outcome', () => {
  it('is shared: a joiner sees the confirmation the first owner earned', async () => {
    const h = harness()
    const first = await h.subscribe(h.owner('first').onFrame)
    notify(monitorAt(0))
    const second = await h.subscribe(h.owner('second').onFrame)

    await expect(first.setupOutcome).resolves.toMatchObject({ success: true })
    await expect(second.setupOutcome).resolves.toMatchObject({ success: true })
    expect(second.result).toBe(first.result)
  })

  it('settles optimistically for every owner on a quiet channel', async () => {
    const h = harness()
    const first = await h.subscribe(h.owner('first').onFrame)
    const second = await h.subscribe(h.owner('second').onFrame)

    jest.advanceTimersByTime(1_000)
    await expect(first.setupOutcome).resolves.toMatchObject({ success: true })
    await expect(second.setupOutcome).resolves.toMatchObject({ success: true })
  })

  it('fails every sharer when the first callback is an error', async () => {
    const h = harness()
    const first = await h.subscribe(h.owner('first').onFrame)
    const second = await h.subscribe(h.owner('second').onFrame)

    monitorAt(0).callback({ message: 'CCCD write failed' }, null)
    const failure = { success: false, errorMessage: 'CCCD write failed' }
    await expect(first.setupOutcome).resolves.toMatchObject(failure)
    await expect(second.setupOutcome).resolves.toMatchObject(failure)
  })
})

describe('across a reconnect', () => {
  it("replaces the previous connection's monitor instead of joining it", async () => {
    // A monitor from a link that dropped delivers nothing more, whether or
    // not its callback ever said so. Joining it would be a silent stream.
    const h = harness()
    await h.ble.connect(GLOVE)
    await h.subscribe(h.owner('before').onFrame)
    await h.ble.connect(GLOVE)
    const after = h.owner('after')
    await h.subscribe(after.onFrame)

    expect(mockMonitors).toHaveLength(2)
    expect(monitorAt(0).remove).toHaveBeenCalledTimes(1)
    notify(monitorAt(1))
    expect(after.frames).toHaveLength(1)
  })

  it('does not let a handle from the old connection tear down the new monitor', async () => {
    // A screen subscribes, the glove drops and reconnects, the keepalive
    // re-arms — and then the screen unmounts and unsubscribes its handle.
    const h = harness()
    await h.ble.connect(GLOVE)
    const stale = await h.subscribe(h.owner('probe').onFrame)
    await h.ble.connect(GLOVE)
    const keepalive = h.owner('keepalive')
    await h.subscribe(keepalive.onFrame)

    stale.unsubscribe()
    expect(monitorAt(1).remove).not.toHaveBeenCalled()
    notify(monitorAt(1))
    expect(keepalive.frames).toHaveLength(1)
  })

  it('ignores the old monitor reporting its own removal late', async () => {
    const h = harness()
    await h.ble.connect(GLOVE)
    await h.subscribe(h.owner('before').onFrame)
    await h.ble.connect(GLOVE)
    await h.subscribe(h.owner('after').onFrame)

    // ble-plx reports our own remove() as an error on the removed monitor.
    monitorAt(0).callback({ message: 'Operation was cancelled' }, null)

    // The successor is still registered: a third owner joins it.
    const third = h.owner('third')
    await h.subscribe(third.onFrame)
    expect(mockMonitors).toHaveLength(2)
    notify(monitorAt(1))
    expect(third.frames).toHaveLength(1)
  })

  it('delivers nothing from the new connection to a listener of the old one', async () => {
    const h = harness()
    await h.ble.connect(GLOVE)
    const before = h.owner('before')
    await h.subscribe(before.onFrame)
    await h.ble.connect(GLOVE)
    await h.subscribe(h.owner('after').onFrame)

    notify(monitorAt(1))
    expect(before.frames).toHaveLength(0)
  })
})

describe('a monitor that has ended', () => {
  it('is replaced, not joined, once its callback has reported an error', async () => {
    const h = harness()
    await h.subscribe(h.owner('first').onFrame)
    notify(monitorAt(0))
    monitorAt(0).callback({ message: 'Device was disconnected' }, null)

    const second = h.owner('second')
    await h.subscribe(second.onFrame)
    expect(mockMonitors).toHaveLength(2)
    notify(monitorAt(1))
    expect(second.frames).toHaveLength(1)
  })

  it('is never registered when it fails inside the call that creates it', async () => {
    const h = harness()
    mockFailNextMonitorWith = 'Device is not connected'
    const failed = await h.subscribe(h.owner('first').onFrame)
    await expect(failed.setupOutcome).resolves.toMatchObject({ success: false })

    const retry = h.owner('retry')
    await h.subscribe(retry.onFrame)
    expect(mockMonitors).toHaveLength(2)
    notify(monitorAt(1))
    expect(retry.frames).toHaveLength(1)
  })

  it('lets its handle unsubscribe without touching the monitor that replaced it', async () => {
    const h = harness()
    const first = await h.subscribe(h.owner('first').onFrame)
    monitorAt(0).callback({ message: 'Device was disconnected' }, null)
    const second = h.owner('second')
    await h.subscribe(second.onFrame)

    first.unsubscribe()
    expect(monitorAt(1).remove).not.toHaveBeenCalled()
    notify(monitorAt(1))
    expect(second.frames).toHaveLength(1)
  })
})

describe('listeners', () => {
  it('does not let one throwing listener starve the others', async () => {
    const h = harness()
    await h.subscribe(() => {
      throw new Error('decoder blew up')
    })
    const healthy = h.owner('healthy')
    await h.subscribe(healthy.onFrame)

    expect(() => notify(monitorAt(0))).not.toThrow()
    expect(healthy.frames).toHaveLength(1)
    // And the frame was already safe before either of them saw it.
    expect(h.captured).toHaveLength(1)
  })

  it('survives a listener that unsubscribes while handling a frame', async () => {
    const h = harness()
    const quitter: { unsubscribe?: () => void } = {}
    const handle = await h.subscribe(() => quitter.unsubscribe?.())
    quitter.unsubscribe = handle.unsubscribe
    const steady = h.owner('steady')
    await h.subscribe(steady.onFrame)

    notify(monitorAt(0))
    notify(monitorAt(0))
    expect(steady.frames).toHaveLength(2)
  })
})

describe('destroy', () => {
  it('removes every native monitor', async () => {
    const h = harness()
    await h.subscribe(h.owner('a').onFrame, PUNCHES)
    await h.subscribe(h.owner('b').onFrame, OTHER)

    await h.ble.destroy()
    expect(monitorAt(0).remove).toHaveBeenCalledTimes(1)
    expect(monitorAt(1).remove).toHaveBeenCalledTimes(1)
  })
})
