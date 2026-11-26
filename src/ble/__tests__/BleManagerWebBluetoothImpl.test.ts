/**
 * BleManagerWebBluetoothImpl — against a fake `navigator.bluetooth`.
 *
 * No browser and no radio: the fake below is the smallest thing that behaves
 * like the slice of Web Bluetooth the transport uses. What is asserted is the
 * facade contract the rest of the app relies on, and the two rules that are
 * properties of a transport: a frame reaches the sink before any listener
 * (CLAUDE.md §1), and the transport writes nothing it was not handed (§4).
 *
 * Whether a real browser pairs with a real glove is not something a fake can
 * say. That is what `tools/pc/glove-check` is for.
 */
import {
  BleManagerWebBluetoothImpl,
  type WebBluetooth,
  type WebBluetoothCharacteristic,
  type WebBluetoothDevice,
  type WebBluetoothServer,
  type WebBluetoothService,
} from '../BleManagerWebBluetoothImpl'
import type { ConnectionStatus, RawBleFrame } from '../bleTypes'
import { replaceSinks } from '@diagnostics/logger'

const SERVICE = 'ca280069-5470-4e34-94dd-caf160200b29'
const STREAM = 'ca281069-5470-4e34-94dd-caf160200b29'
const COMMAND = 'ca281071-5470-4e34-94dd-caf160200b29'
const INFO = 'ca281070-5470-4e34-94dd-caf160200b29'

beforeAll(() => {
  replaceSinks([])
})

class FakeCharacteristic implements WebBluetoothCharacteristic {
  value: DataView | null = null
  readonly writes: Array<{ bytes: number[]; withResponse: boolean }> = []
  startCalls = 0
  stopCalls = 0
  failStart: Error | null = null
  readBytes: number[] = [0x05, 0x00]
  private readonly listeners = new Set<() => void>()

  constructor(
    readonly uuid: string,
    readonly properties: WebBluetoothCharacteristic['properties'],
  ) {}

  async readValue(): Promise<DataView> {
    return new DataView(Uint8Array.from(this.readBytes).buffer)
  }
  async writeValueWithResponse(data: Uint8Array): Promise<void> {
    this.writes.push({ bytes: [...data], withResponse: true })
  }
  async writeValueWithoutResponse(data: Uint8Array): Promise<void> {
    this.writes.push({ bytes: [...data], withResponse: false })
  }
  async startNotifications(): Promise<unknown> {
    this.startCalls += 1
    if (this.failStart) throw this.failStart
    return this
  }
  async stopNotifications(): Promise<unknown> {
    this.stopCalls += 1
    return this
  }
  addEventListener(_type: 'characteristicvaluechanged', listener: () => void): void {
    this.listeners.add(listener)
  }
  removeEventListener(_type: 'characteristicvaluechanged', listener: () => void): void {
    this.listeners.delete(listener)
  }
  /** The glove sends a notification. */
  notify(bytes: number[]): void {
    this.value = new DataView(Uint8Array.from(bytes).buffer)
    for (const listener of [...this.listeners]) listener()
  }
  get listenerCount(): number {
    return this.listeners.size
  }
}

const props = (
  over: Partial<WebBluetoothCharacteristic['properties']>,
): WebBluetoothCharacteristic['properties'] => ({
  read: false,
  write: false,
  writeWithoutResponse: false,
  notify: false,
  indicate: false,
  ...over,
})

function fakeGlove(id = 'opaque-id-1') {
  const stream = new FakeCharacteristic(STREAM, props({ indicate: true }))
  const command = new FakeCharacteristic(COMMAND, props({ write: true }))
  const info = new FakeCharacteristic(INFO, props({ read: true }))
  const characteristics = [stream, command, info]
  const service: WebBluetoothService = {
    uuid: SERVICE,
    getCharacteristics: async () => characteristics,
    getCharacteristic: async (uuid) => {
      const found = characteristics.find((c) => c.uuid === uuid)
      if (!found) throw new Error(`no characteristic ${uuid}`)
      return found
    },
  }
  const disconnectListeners = new Set<() => void>()
  let failConnect: Error | null = null
  const server: WebBluetoothServer = {
    connected: false,
    connect: async () => {
      if (failConnect) throw failConnect
      server.connected = true
      return server
    },
    disconnect: () => {
      if (!server.connected) return
      server.connected = false
      for (const listener of [...disconnectListeners]) listener()
    },
    getPrimaryServices: async () => [service],
    getPrimaryService: async (uuid) => {
      if (uuid !== SERVICE) throw new Error(`no service ${uuid}`)
      return service
    },
  }
  const device: WebBluetoothDevice = {
    id,
    name: 'FightCam',
    gatt: server,
    addEventListener: (_type, listener) => disconnectListeners.add(listener),
    removeEventListener: (_type, listener) => disconnectListeners.delete(listener),
  }
  return {
    device,
    server,
    stream,
    command,
    info,
    /** The link drops on its own, as it does at 37 s without a bond. */
    drop: () => server.disconnect(),
    failNextConnect: (err: Error) => {
      failConnect = err
    },
  }
}

function harness(glove = fakeGlove()) {
  const requests: Array<Parameters<WebBluetooth['requestDevice']>[0]> = []
  let clock = 1_000
  const bluetooth: WebBluetooth = {
    requestDevice: async (options) => {
      requests.push(options)
      return glove.device
    },
    getAvailability: async () => true,
  }
  const ble = new BleManagerWebBluetoothImpl({
    bluetooth,
    now: () => (clock += 1),
    wallNowIso: () => '2026-11-25T00:00:00.000Z',
  })
  const pick = () =>
    ble.pickDevice({ serviceUuids: [SERVICE], optionalServiceUuids: ['battery_service'] })
  return { ble, glove, requests, pick }
}

describe('choosing a device', () => {
  it('asks the browser for the given service, and for the optional ones', async () => {
    const h = harness()
    const picked = await h.pick()
    expect(h.requests).toEqual([
      { filters: [{ services: [SERVICE] }], optionalServices: ['battery_service'] },
    ])
    expect(picked).toEqual({ deviceId: 'opaque-id-1', name: 'FightCam' })
  })

  it('cannot scan, and says what to do instead', async () => {
    const h = harness()
    await expect(h.ble.scan({}, () => undefined)).rejects.toThrow(/pickDevice\(\) from a click/)
  })

  it('refuses a device that was never chosen', async () => {
    const h = harness()
    await expect(h.ble.connect('never-picked')).rejects.toThrow(/pickDevice\(\) first/)
  })
})

describe('connecting', () => {
  it('reports connecting, then ready, and counts the connection', async () => {
    const h = harness()
    const { deviceId } = await h.pick()
    const seen: ConnectionStatus[] = []
    h.ble.onConnectionChange(deviceId, (s) => seen.push(s))

    const status = await h.ble.connect(deviceId)

    expect(seen.map((s) => s.state)).toEqual(['connecting', 'ready'])
    expect(status).toMatchObject({ deviceId, state: 'ready', generation: 1 })
    expect(await h.ble.isConnected(deviceId)).toBe(true)
  })

  it('reports an error, and throws, when the browser cannot connect', async () => {
    const h = harness()
    const { deviceId } = await h.pick()
    const seen: ConnectionStatus[] = []
    h.ble.onConnectionChange(deviceId, (s) => seen.push(s))
    h.glove.failNextConnect(new Error('GATT Server is disconnected'))

    await expect(h.ble.connect(deviceId)).rejects.toThrow('GATT Server is disconnected')
    expect(seen.map((s) => s.state)).toEqual(['connecting', 'error'])
    expect(seen[1]?.errorMessage).toBe('GATT Server is disconnected')
    expect(await h.ble.isConnected(deviceId)).toBe(false)
  })

  it('reports dormant when the link drops, and a reconnect is a new generation', async () => {
    const h = harness()
    const { deviceId } = await h.pick()
    await h.ble.connect(deviceId)
    const seen: ConnectionStatus[] = []
    h.ble.onConnectionChange(deviceId, (s) => seen.push(s))

    h.glove.drop()
    expect(seen.map((s) => s.state)).toEqual(['dormant'])
    expect(await h.ble.isConnected(deviceId)).toBe(false)

    expect((await h.ble.connect(deviceId)).generation).toBe(2)
  })

  it('lists the services and characteristics it can reach', async () => {
    const h = harness()
    const { deviceId } = await h.pick()
    await h.ble.connect(deviceId)
    const snapshot = await h.ble.discoverAllServicesAndCharacteristics(deviceId)
    expect(snapshot.services.map((s) => s.uuid)).toEqual([SERVICE])
    expect(
      snapshot.services[0]?.characteristics.map((c) => [c.uuid, c.properties.indicate]),
    ).toEqual([
      [STREAM, true],
      [COMMAND, false],
      [INFO, false],
    ])
  })
})

describe('frames', () => {
  const connected = async () => {
    const h = harness()
    const { deviceId } = await h.pick()
    await h.ble.connect(deviceId)
    return { ...h, deviceId }
  }

  it('delivers a notification as a raw frame', async () => {
    const h = await connected()
    const frames: RawBleFrame[] = []
    const handle = await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, (f) =>
      frames.push(f),
    )
    expect(await handle.setupOutcome).toMatchObject({ success: true, direction: 'indication' })

    h.glove.stream.notify([0x01, 0xab, 0xff])

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      deviceId: h.deviceId,
      characteristicUuid: STREAM,
      direction: 'indication',
      valueHex: '01abff',
      valueBase64: 'Aav/',
      connectionGeneration: 1,
      handAtCapture: 'unknown',
    })
  })

  it('hands the frame to the sink BEFORE any listener (raw before parsed)', async () => {
    const h = await connected()
    const order: string[] = []
    h.ble.setFrameSink({ capture: () => order.push('sink') })
    await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, () => order.push('listener'))

    h.glove.stream.notify([0x01])

    expect(order).toEqual(['sink', 'listener'])
  })

  it('captures a frame once however many listeners share the characteristic', async () => {
    const h = await connected()
    let captured = 0
    h.ble.setFrameSink({ capture: () => (captured += 1) })
    const a: string[] = []
    const b: string[] = []
    await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, (f) => a.push(f.id))
    await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, (f) => b.push(f.id))

    h.glove.stream.notify([0x01])

    expect(h.glove.stream.startCalls).toBe(1)
    expect(captured).toBe(1)
    expect(a).toEqual(b)
    expect(a).toHaveLength(1)
  })

  it('keeps the subscription while one listener remains, and ends it with the last', async () => {
    const h = await connected()
    const seen: string[] = []
    const first = await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, () =>
      seen.push('first'),
    )
    const second = await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, () =>
      seen.push('second'),
    )

    first.unsubscribe()
    h.glove.stream.notify([0x01])
    expect(seen).toEqual(['second'])
    expect(h.glove.stream.stopCalls).toBe(0)

    second.unsubscribe()
    expect(h.glove.stream.stopCalls).toBe(1)
    expect(h.glove.stream.listenerCount).toBe(0)
  })

  it('reports a subscription the browser refused', async () => {
    const h = await connected()
    h.glove.stream.failStart = new Error('GATT operation not permitted')
    const handle = await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, () => undefined)
    expect(await handle.setupOutcome).toMatchObject({
      success: false,
      errorMessage: 'GATT operation not permitted',
    })
  })

  it('still delivers when the sink throws, and to the others when one listener throws', async () => {
    const h = await connected()
    h.ble.setFrameSink({
      capture: () => {
        throw new Error('disk full')
      },
    })
    const seen: string[] = []
    await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, () => {
      throw new Error('listener bug')
    })
    await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, () => seen.push('ok'))

    expect(() => h.glove.stream.notify([0x01])).not.toThrow()
    expect(seen).toEqual(['ok'])
  })

  it('starts a fresh subscription after the link drops and comes back', async () => {
    const h = await connected()
    await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, () => undefined)
    h.glove.drop()
    await h.ble.connect(h.deviceId)
    await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, () => undefined)
    expect(h.glove.stream.startCalls).toBe(2)
  })
})

describe('reads and writes', () => {
  const connected = async () => {
    const h = harness()
    const { deviceId } = await h.pick()
    await h.ble.connect(deviceId)
    return { ...h, deviceId }
  }

  it('reads a characteristic as hex and base64', async () => {
    const h = await connected()
    h.glove.info.readBytes = [0x05, 0x00]
    expect(await h.ble.readCharacteristic(h.deviceId, SERVICE, INFO)).toMatchObject({
      success: true,
      valueHex: '0500',
      valueBase64: 'BQA=',
    })
  })

  it('writes exactly the bytes it was handed, from hex or from base64', async () => {
    const h = await connected()
    await h.ble.writeCharacteristic(h.deviceId, SERVICE, COMMAND, { hex: '01' }, true)
    await h.ble.writeCharacteristic(h.deviceId, SERVICE, COMMAND, { base64: 'EQ==' }, false)
    expect(h.glove.command.writes).toEqual([
      { bytes: [0x01], withResponse: true },
      { bytes: [0x11], withResponse: false },
    ])
  })

  it('reports a failed write instead of throwing', async () => {
    const h = await connected()
    const result = await h.ble.writeCharacteristic(
      h.deviceId,
      SERVICE,
      COMMAND,
      { hex: 'zz' },
      true,
    )
    expect(result.success).toBe(false)
    expect(result.errorMessage).toMatch(/hex/)
    expect(h.glove.command.writes).toEqual([])
  })

  it('never writes on its own — connecting, discovering, subscribing and reading send nothing', async () => {
    // CLAUDE.md rule 4. Everything a consumer can do short of calling
    // writeCharacteristic, then count the writes.
    const h = await connected()
    await h.ble.discoverAllServicesAndCharacteristics(h.deviceId)
    const handle = await h.ble.monitorCharacteristic(h.deviceId, SERVICE, STREAM, () => undefined)
    await handle.setupOutcome
    await h.ble.readCharacteristic(h.deviceId, SERVICE, INFO)
    h.glove.stream.notify([0x01])
    handle.unsubscribe()
    await h.ble.disconnect(h.deviceId)

    expect([h.glove.stream, h.glove.command, h.glove.info].flatMap((c) => c.writes)).toEqual([])
  })
})
