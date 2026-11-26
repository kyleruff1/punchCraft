/**
 * BleManagerWebBluetoothImpl — the BleManagerFacade over the browser's Web
 * Bluetooth API (`navigator.bluetooth`), for the PC version of the app.
 *
 * It implements the same contract as `BleManagerBlePlxImpl`, so everything
 * above the facade — `startPunchStream`, the FightCamp adapter and decoder,
 * the keepalive — runs unchanged. What a browser changes sits below it:
 *
 * - **No scanning.** A page cannot list nearby devices. It can only ask the
 *   browser to show its own chooser, and only from a user's click. That is
 *   `pickDevice()`; `scan()` says so rather than pretending.
 * - **No addresses.** A device is known by an opaque, per-origin id. The app
 *   elsewhere tells left from right by address (`KNOWN_TRACKERS`); here that
 *   has to be decided by whoever calls `pickDevice()`.
 * - **No pairing call.** If the glove asks for a bond, the browser and the
 *   OS answer it or they do not (H13). There is nothing here to ask with.
 * - **Only named services are reachable.** A service not listed when the
 *   device was picked does not exist as far as the page is concerned.
 *
 * The two rules that are properties of the transport hold here too:
 *
 * - **Raw before parsed** (CLAUDE.md §1): every frame goes to the frame sink
 *   before any listener sees it, once, however many listeners there are.
 * - **No writes of its own** (CLAUDE.md §4): `writeCharacteristic` sends
 *   exactly what a caller passes. Nothing in this file originates a write.
 *
 * Nothing here imports a BLE library, React or React Native: it runs in a
 * plain page as well as in the web build.
 */
import { base64ToHex, bytesToHex, hexToBase64, hexToBytes } from './bleBytes'
import type {
  AdvertisementSnapshot,
  ConnectionStatus,
  GattCharacteristicSnapshot,
  GattServiceSnapshot,
  GattSnapshot,
  RawBleFrame,
  RawFrameSink,
  ReadResult,
  SubscriptionResult,
  WriteResult,
} from './bleTypes'
import type {
  BleManagerFacade,
  ConnectOptions,
  ScanOptions,
  SubscriptionHandle,
  UnsubscribeFn,
} from './BleManagerFacade'
import { deviceSensitive, logger, safe } from '@/diagnostics/logger'

// ---------------------------------------------------------------------------
// The slice of the Web Bluetooth API this file uses, as structural types.
// TypeScript's DOM library does not include Web Bluetooth, and declaring only
// what is used keeps a test's fake honest about what it has to provide.
// ---------------------------------------------------------------------------

export interface WebBluetoothCharacteristic {
  uuid: string
  properties: {
    read: boolean
    write: boolean
    writeWithoutResponse: boolean
    notify: boolean
    indicate: boolean
  }
  value?: DataView | null
  readValue(): Promise<DataView>
  writeValueWithResponse?(data: Uint8Array): Promise<void>
  writeValueWithoutResponse?(data: Uint8Array): Promise<void>
  writeValue?(data: Uint8Array): Promise<void>
  startNotifications(): Promise<unknown>
  stopNotifications(): Promise<unknown>
  addEventListener(type: 'characteristicvaluechanged', listener: () => void): void
  removeEventListener(type: 'characteristicvaluechanged', listener: () => void): void
}

export interface WebBluetoothService {
  uuid: string
  getCharacteristics(): Promise<WebBluetoothCharacteristic[]>
  getCharacteristic(uuid: string): Promise<WebBluetoothCharacteristic>
}

export interface WebBluetoothServer {
  connected: boolean
  connect(): Promise<WebBluetoothServer>
  disconnect(): void
  getPrimaryServices(): Promise<WebBluetoothService[]>
  getPrimaryService(uuid: string): Promise<WebBluetoothService>
}

export interface WebBluetoothDevice {
  id: string
  name?: string | null
  gatt?: WebBluetoothServer | null
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void
  removeEventListener(type: 'gattserverdisconnected', listener: () => void): void
}

export interface WebBluetooth {
  requestDevice(options: {
    filters: Array<{ services?: string[]; namePrefix?: string }>
    optionalServices?: string[]
  }): Promise<WebBluetoothDevice>
  getAvailability?(): Promise<boolean>
}

export interface PickDeviceOptions {
  /** The chooser lists devices advertising one of these services… */
  serviceUuids: string[]
  /**
   * …or whose advertised name starts with one of these. A device that
   * matches only by name is reachable only through `optionalServiceUuids`,
   * so list the services there as well.
   */
  namePrefixes?: string[]
  /** Further services the page will read or subscribe to once connected. */
  optionalServiceUuids?: string[]
}

export interface PickedDevice {
  /** Opaque, per-origin. NOT an address — see the header. */
  deviceId: string
  name?: string
}

export interface WebBluetoothImplOptions {
  bluetooth: WebBluetooth
  /** Monotonic milliseconds. Defaults to `performance.now()`. */
  now?: () => number
  /** Wall time, for display and export only. Defaults to the system clock. */
  wallNowIso?: () => string
}

interface Monitor {
  characteristic: WebBluetoothCharacteristic
  listeners: Set<(frame: RawBleFrame) => void>
  onValue: () => void
  result: SubscriptionResult
  setupOutcome: Promise<SubscriptionResult>
}

interface DeviceEntry {
  device: WebBluetoothDevice
  generation: number
  monitors: Map<string, Monitor>
  onDisconnected: (() => void) | null
}

const monitorKey = (serviceUuid: string, characteristicUuid: string): string =>
  `${serviceUuid.toLowerCase()}|${characteristicUuid.toLowerCase()}`

const bytesOf = (view: DataView): Uint8Array =>
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength)

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class BleManagerWebBluetoothImpl implements BleManagerFacade {
  private readonly bluetooth: WebBluetooth
  private readonly now: () => number
  private readonly wallNowIso: () => string
  private readonly devices = new Map<string, DeviceEntry>()
  private readonly connectionListeners = new Map<string, Set<(s: ConnectionStatus) => void>>()
  private frameSink: RawFrameSink | null = null
  private getCaptureId: () => string = () => 'ephemeral'
  private seq = 0

  constructor(options: WebBluetoothImplOptions) {
    this.bluetooth = options.bluetooth
    this.now = options.now ?? (() => performance.now())
    this.wallNowIso = options.wallNowIso ?? (() => new Date().toISOString())
  }

  setCaptureIdProvider(provider: () => string): void {
    this.getCaptureId = provider
  }

  setFrameSink(sink: RawFrameSink | null): void {
    this.frameSink = sink
  }

  async isReady(): Promise<boolean> {
    try {
      return (await this.bluetooth.getAvailability?.()) ?? true
    } catch {
      return false
    }
  }

  onAdapterStateChange(
    cb: (state: 'unknown' | 'off' | 'on' | 'unauthorized') => void,
  ): UnsubscribeFn {
    // A page is told once whether the machine has Bluetooth; it is not told
    // when the radio is switched off later. Report what can be known.
    let live = true
    void this.isReady().then((ready) => {
      if (live) cb(ready ? 'on' : 'off')
    })
    return () => {
      live = false
    }
  }

  /**
   * Show the browser's device chooser. MUST be called from a user gesture —
   * a click handler — or the browser refuses.
   *
   * This replaces scanning. The chooser lists devices advertising one of
   * `serviceUuids`; the user picks one; the page learns only that device.
   */
  async pickDevice(options: PickDeviceOptions): Promise<PickedDevice> {
    const device = await this.bluetooth.requestDevice({
      filters: [
        { services: options.serviceUuids },
        ...(options.namePrefixes ?? []).map((namePrefix) => ({ namePrefix })),
      ],
      optionalServices: options.optionalServiceUuids ?? [],
    })
    if (!this.devices.has(device.id)) {
      this.devices.set(device.id, {
        device,
        generation: 0,
        monitors: new Map(),
        onDisconnected: null,
      })
    }
    logger.info('ble.web.picked', 'a device was chosen in the browser', {
      deviceId: deviceSensitive(device.id),
      name: safe(device.name ?? null),
    })
    return { deviceId: device.id, ...(device.name ? { name: device.name } : {}) }
  }

  scan(
    _options: ScanOptions,
    _onAdvertisement: (ad: AdvertisementSnapshot) => void,
  ): Promise<void> {
    return Promise.reject(
      new Error(
        'Web Bluetooth cannot scan. Call pickDevice() from a click; the browser shows its own chooser.',
      ),
    )
  }

  async stopScan(): Promise<void> {
    // Nothing to stop: there is no scan.
  }

  async connect(deviceId: string, _options?: ConnectOptions): Promise<ConnectionStatus> {
    const entry = this.entry(deviceId)
    const gatt = entry.device.gatt
    if (!gatt) throw new Error('this device exposes no GATT server')

    this.emit({ deviceId, state: 'connecting', generation: entry.generation })
    try {
      await gatt.connect()
    } catch (err) {
      this.emit({
        deviceId,
        state: 'error',
        generation: entry.generation,
        errorMessage: messageOf(err),
      })
      throw err
    }
    entry.generation += 1
    this.watchDisconnect(deviceId, entry)
    return this.emit({ deviceId, state: 'ready', generation: entry.generation })
  }

  async disconnect(deviceId: string): Promise<void> {
    const entry = this.devices.get(deviceId)
    if (!entry) return
    // The browser fires `gattserverdisconnected`, which does the bookkeeping.
    entry.device.gatt?.disconnect()
  }

  async isConnected(deviceId: string): Promise<boolean> {
    return this.devices.get(deviceId)?.device.gatt?.connected === true
  }

  onConnectionChange(deviceId: string, cb: (status: ConnectionStatus) => void): UnsubscribeFn {
    const set = this.connectionListeners.get(deviceId) ?? new Set()
    set.add(cb)
    this.connectionListeners.set(deviceId, set)
    return () => {
      set.delete(cb)
    }
  }

  async discoverAllServicesAndCharacteristics(deviceId: string): Promise<GattSnapshot> {
    const gatt = this.connectedGatt(deviceId)
    const services: GattServiceSnapshot[] = []
    for (const service of await gatt.getPrimaryServices()) {
      const characteristics: GattCharacteristicSnapshot[] = []
      for (const c of await service.getCharacteristics()) {
        characteristics.push({
          uuid: c.uuid,
          properties: {
            read: c.properties.read,
            write: c.properties.write,
            writeWithoutResponse: c.properties.writeWithoutResponse,
            notify: c.properties.notify,
            indicate: c.properties.indicate,
          },
          // Descriptors are not read: nothing above the facade uses them.
          descriptors: [],
        })
      }
      services.push({ uuid: service.uuid, characteristics })
    }
    return { deviceId, services, discoveredAtMonotonicMs: this.now() }
  }

  /**
   * Subscribe to a characteristic.
   *
   * One native subscription per characteristic, however many callers ask:
   * later callers join the first one's monitor and share its outcome. Two
   * `startNotifications()` on one characteristic would deliver every frame
   * twice into the sink. The native transport learned this the hard way
   * (H-3); this one starts out that way.
   */
  async monitorCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    onFrame: (frame: RawBleFrame) => void,
  ): Promise<SubscriptionHandle> {
    const entry = this.entry(deviceId)
    const key = monitorKey(serviceUuid, characteristicUuid)
    let monitor = entry.monitors.get(key)

    if (!monitor) {
      const characteristic = await this.characteristic(deviceId, serviceUuid, characteristicUuid)
      const direction = characteristic.properties.notify ? 'notification' : 'indication'
      const result: SubscriptionResult = {
        serviceUuid,
        characteristicUuid,
        direction,
        success: true,
      }
      const listeners = new Set<(frame: RawBleFrame) => void>()
      const onValue = (): void => {
        const value = characteristic.value
        if (!value) return
        this.deliver(deviceId, serviceUuid, characteristicUuid, direction, value, listeners)
      }
      characteristic.addEventListener('characteristicvaluechanged', onValue)
      // `startNotifications` resolves once the subscription is really in
      // place, so its outcome IS the definitive one — no settling window.
      const setupOutcome = characteristic.startNotifications().then(
        () => result,
        (err: unknown) => {
          result.success = false
          result.errorMessage = messageOf(err)
          characteristic.removeEventListener('characteristicvaluechanged', onValue)
          entry.monitors.delete(key)
          return result
        },
      )
      monitor = { characteristic, listeners, onValue, result, setupOutcome }
      entry.monitors.set(key, monitor)
    }

    const joined = monitor
    joined.listeners.add(onFrame)
    return {
      result: joined.result,
      setupOutcome: joined.setupOutcome,
      unsubscribe: () => {
        joined.listeners.delete(onFrame)
        if (joined.listeners.size > 0 || entry.monitors.get(key) !== joined) return
        entry.monitors.delete(key)
        joined.characteristic.removeEventListener('characteristicvaluechanged', joined.onValue)
        void joined.characteristic.stopNotifications().catch(() => {
          /* the link may already be gone */
        })
      },
    }
  }

  async monitorAllNotifiable(
    snapshot: GattSnapshot,
    onFrame: (frame: RawBleFrame) => void,
  ): Promise<SubscriptionHandle[]> {
    const handles: SubscriptionHandle[] = []
    for (const service of snapshot.services) {
      for (const c of service.characteristics) {
        if (!c.properties.notify && !c.properties.indicate) continue
        handles.push(
          await this.monitorCharacteristic(snapshot.deviceId, service.uuid, c.uuid, onFrame),
        )
      }
    }
    return handles
  }

  /** Sends exactly `payload`. This file never originates a write (CLAUDE.md §4). */
  async writeCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    payload: { base64?: string; hex?: string },
    withResponse: boolean,
  ): Promise<WriteResult> {
    const startedAt = this.now()
    try {
      const hex = payload.hex ?? (payload.base64 !== undefined ? base64ToHex(payload.base64) : null)
      if (hex === null) throw new Error('writeCharacteristic needs a hex or base64 payload')
      const bytes = hexToBytes(hex)
      const c = await this.characteristic(deviceId, serviceUuid, characteristicUuid)
      const send = withResponse
        ? (c.writeValueWithResponse ?? c.writeValue)
        : (c.writeValueWithoutResponse ?? c.writeValue)
      if (!send) throw new Error('this browser cannot write to a characteristic')
      await send.call(c, bytes)
      return { success: true, bytesWritten: bytes.length, durationMs: this.now() - startedAt }
    } catch (err) {
      return {
        success: false,
        bytesWritten: 0,
        durationMs: this.now() - startedAt,
        errorMessage: messageOf(err),
      }
    }
  }

  async readCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<ReadResult> {
    const startedAt = this.now()
    try {
      const c = await this.characteristic(deviceId, serviceUuid, characteristicUuid)
      const valueHex = bytesToHex(bytesOf(await c.readValue()))
      return {
        success: true,
        valueHex,
        valueBase64: hexToBase64(valueHex),
        durationMs: this.now() - startedAt,
      }
    } catch (err) {
      return { success: false, durationMs: this.now() - startedAt, errorMessage: messageOf(err) }
    }
  }

  async destroy(): Promise<void> {
    for (const entry of this.devices.values()) entry.device.gatt?.disconnect()
    this.devices.clear()
    this.connectionListeners.clear()
  }

  // -- internals -------------------------------------------------------------

  private entry(deviceId: string): DeviceEntry {
    const entry = this.devices.get(deviceId)
    if (!entry) {
      throw new Error('unknown device: it has to be chosen with pickDevice() first')
    }
    return entry
  }

  private connectedGatt(deviceId: string): WebBluetoothServer {
    const gatt = this.entry(deviceId).device.gatt
    if (!gatt || !gatt.connected) throw new Error('device is not connected')
    return gatt
  }

  private async characteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<WebBluetoothCharacteristic> {
    const service = await this.connectedGatt(deviceId).getPrimaryService(serviceUuid.toLowerCase())
    return service.getCharacteristic(characteristicUuid.toLowerCase())
  }

  private deliver(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    direction: 'notification' | 'indication',
    value: DataView,
    listeners: ReadonlySet<(frame: RawBleFrame) => void>,
  ): void {
    const valueHex = bytesToHex(bytesOf(value))
    const captureId = this.getCaptureId()
    const frame: RawBleFrame = {
      id: `${captureId}-${this.seq++}`,
      captureId,
      deviceId,
      handAtCapture: 'unknown',
      monotonicTimeMs: this.now(),
      wallTimeIso: this.wallNowIso(),
      direction,
      serviceUuid,
      characteristicUuid,
      valueBase64: hexToBase64(valueHex),
      valueHex,
      connectionGeneration: this.devices.get(deviceId)?.generation ?? 0,
    }
    // PERSIST BEFORE DELIVERY (CLAUDE.md §1): once, before any listener, and
    // a sink that throws must not cost the listeners their frame.
    try {
      this.frameSink?.capture(frame)
    } catch {
      /* sink contract violation — never break delivery */
    }
    for (const listener of [...listeners]) {
      try {
        listener(frame)
      } catch (err) {
        logger.warn('ble.monitor.listener.threw', 'a frame listener threw', {
          deviceId: deviceSensitive(deviceId),
          characteristicUuid: deviceSensitive(characteristicUuid),
          errorMessage: safe(messageOf(err)),
        })
      }
    }
  }

  private watchDisconnect(deviceId: string, entry: DeviceEntry): void {
    if (entry.onDisconnected) return
    const onDisconnected = (): void => {
      // The subscriptions died with the link; a reconnect starts clean.
      for (const monitor of entry.monitors.values()) {
        monitor.characteristic.removeEventListener('characteristicvaluechanged', monitor.onValue)
      }
      entry.monitors.clear()
      this.emit({ deviceId, state: 'dormant', generation: entry.generation })
    }
    entry.onDisconnected = onDisconnected
    entry.device.addEventListener('gattserverdisconnected', onDisconnected)
  }

  private emit(partial: Omit<ConnectionStatus, 'lastChangeMonotonicMs'>): ConnectionStatus {
    const status: ConnectionStatus = { ...partial, lastChangeMonotonicMs: this.now() }
    for (const cb of [...(this.connectionListeners.get(status.deviceId) ?? [])]) {
      try {
        cb(status)
      } catch {
        /* one listener must not starve the others */
      }
    }
    return status
  }
}
