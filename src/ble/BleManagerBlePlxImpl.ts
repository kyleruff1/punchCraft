/**
 * Concrete BleManagerFacade implementation on top of
 * @sfourdrinier/react-native-ble-plx (v3.9.3). Nothing outside src/ble/
 * may import from this file — consumers go through BleManagerFacade
 * (§11.4, §15.1).
 *
 * Every notification callback stamps performance.now() before any
 * parsing (§11.9, §12.4) and builds the RawBleFrame in place so the
 * capture sink can persist the raw bytes before any interpretation.
 */
import {
  BleManager as PlxBleManager,
  ConnectionPriority,
  type Characteristic as PlxCharacteristic,
  type Device as PlxDevice,
  type State as PlxState,
  type Subscription as PlxSubscription,
} from '@sfourdrinier/react-native-ble-plx'

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
import { deviceSensitive, logger, safe } from '@/diagnostics/logger'
import { base64ToHex, hexToBase64 } from './bleBytes'
import {
  resetBleManagerSingleton,
  type BleManagerFacade,
  type ConnectOptions,
  type ScanOptions,
  type SubscriptionHandle,
  type UnsubscribeFn,
} from '@/ble/BleManagerFacade'

const DEFAULT_SCAN_TIMEOUT_MS = 12_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

function mapAdapterState(s: keyof typeof PlxState): 'unknown' | 'off' | 'on' | 'unauthorized' {
  switch (s) {
    case 'PoweredOn':
      return 'on'
    case 'PoweredOff':
    case 'Resetting':
      return 'off'
    case 'Unauthorized':
      return 'unauthorized'
    default:
      return 'unknown'
  }
}

function nowMonotonicMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

type SubKey = string

/** One subscriber to a monitor. An object, so membership has an identity. */
interface MonitorListener {
  onFrame: (frame: RawBleFrame) => void
}

/**
 * One native notify/indicate monitor and everyone listening to it — see
 * `monitorCharacteristic`.
 */
interface MonitorEntry {
  /** Null only between construction and the native call returning. */
  sub: PlxSubscription | null
  /** The connection generation this monitor was installed on. */
  generation: number
  listeners: Set<MonitorListener>
  /** Shared by every listener: the subscription has one outcome. */
  result: SubscriptionResult
  setupOutcome: Promise<SubscriptionResult>
  /** The native monitor has ended; it is never joined again. */
  dead: boolean
}
function subKey(deviceId: string, serviceUuid: string, characteristicUuid: string): SubKey {
  return `${deviceId}:${serviceUuid}:${characteristicUuid}`
}

/** Time to wait for the first monitor callback before treating a quiet
 * channel as "subscription is set up and just not delivering frames yet".
 * Longer than the CCCD-write round-trip on any tablet we care about, but
 * short enough to keep the spike responsive. */
const SETUP_OUTCOME_QUIET_MS = 800

export { Base64DecodeError, HexDecodeError } from './bleBytes'

export class BleManagerBlePlxImpl implements BleManagerFacade {
  private manager: PlxBleManager | null = null
  private scanTimeout: ReturnType<typeof setTimeout> | null = null
  private scanResolvers: Array<() => void> = []
  private seq = 0
  private readonly generations = new Map<string, number>()
  private readonly connectionListeners = new Map<string, Set<(s: ConnectionStatus) => void>>()
  private readonly disconnectSubs = new Map<string, PlxSubscription>()
  private readonly monitors = new Map<SubKey, MonitorEntry>()

  /** Overridable getter — the capture pipeline swaps this in when a real
   * capture opens; until then frames are tagged 'ephemeral'. */
  getCaptureId: () => string = () => 'ephemeral'

  setCaptureIdProvider(provider: () => string): void {
    this.getCaptureId = provider
  }

  /**
   * Durable sink for raw frames. Every frame is handed here BEFORE it is
   * delivered to the subscriber that asked for it, so persist-before-parse
   * holds for every consumer — Live decode, the protocol probe, the BLE
   * spike — without any of them opting in.
   */
  private frameSink: RawFrameSink | null = null

  setFrameSink(sink: RawFrameSink | null): void {
    this.frameSink = sink
  }

  private ensure(): PlxBleManager {
    if (!this.manager) this.manager = new PlxBleManager()
    return this.manager
  }

  async isReady(): Promise<boolean> {
    const state = await this.ensure().state()
    return state === 'PoweredOn'
  }

  onAdapterStateChange(
    cb: (state: 'unknown' | 'off' | 'on' | 'unauthorized') => void,
  ): UnsubscribeFn {
    const sub = this.ensure().onStateChange((s) => cb(mapAdapterState(s)), true)
    return () => sub.remove()
  }

  async scan(
    options: ScanOptions,
    onAdvertisement: (ad: AdvertisementSnapshot) => void,
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
    const uuids =
      options.serviceUuids && options.serviceUuids.length > 0 ? options.serviceUuids : null
    const seen = new Set<string>()
    const stopAfter = options.stopAfterDevices ?? Infinity

    const manager = this.ensure()

    // ble-plx's startDeviceScan is fire-and-forget (returns void). Hold a
    // resolver here so scan() actually blocks its caller until the scan
    // window terminates via stopScan (called from stopAfter, the internal
    // timeout, or externally).
    let resolveScan: () => void = () => {}
    const scanPromise = new Promise<void>((resolve) => {
      resolveScan = resolve
    })
    this.scanResolvers.push(resolveScan)

    // Register the callback WITHOUT awaiting.
    manager.startDeviceScan(uuids, null, (err, device) => {
      // STAMP FIRST — before any error/null checks (§11.9).
      const monotonicTimeMs = performance.now()
      if (err || !device) return
      const wallTimeIso = new Date().toISOString()
      seen.add(device.id)
      const ad: AdvertisementSnapshot = {
        deviceId: device.id,
        name: device.name ?? device.localName ?? undefined,
        rssi: device.rssi ?? undefined,
        serviceUuids: device.serviceUUIDs ?? [],
        manufacturerDataBase64: device.manufacturerData ?? undefined,
        monotonicTimeMs,
        wallTimeIso,
      }
      onAdvertisement(ad)
      if (seen.size >= stopAfter) {
        void this.stopScan()
      }
    })

    if (this.scanTimeout) clearTimeout(this.scanTimeout)
    this.scanTimeout = setTimeout(() => {
      void this.stopScan()
    }, timeoutMs)

    return scanPromise
  }

  async stopScan(): Promise<void> {
    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout)
      this.scanTimeout = null
    }
    if (this.manager) {
      try {
        await this.manager.stopDeviceScan()
      } catch {
        /* already stopped is fine */
      }
    }
    const resolvers = this.scanResolvers
    this.scanResolvers = []
    for (const r of resolvers) r()
  }

  private bumpGeneration(deviceId: string): number {
    const next = (this.generations.get(deviceId) ?? 0) + 1
    this.generations.set(deviceId, next)
    return next
  }

  private currentGeneration(deviceId: string): number {
    return this.generations.get(deviceId) ?? 0
  }

  private emitStatus(status: ConnectionStatus): void {
    const set = this.connectionListeners.get(status.deviceId)
    if (!set) return
    for (const cb of set) {
      try {
        cb(status)
      } catch {
        /* listener errors must not break the facade */
      }
    }
  }

  /** Wire (or re-wire) the per-device disconnect subscription. */
  private watchDisconnect(manager: PlxBleManager, deviceId: string): void {
    const prior = this.disconnectSubs.get(deviceId)
    if (prior) prior.remove()
    const sub = manager.onDeviceDisconnected(deviceId, (err, _d) => {
      // Every drop gets a line with the stack's reason: a tracker
      // dozing off, a supervision timeout, and our own cancel all
      // looked identical as silence — which is how a night was lost
      // to "can't hold both gloves" (2026-08-29).
      logger.info('ble.device.disconnected', 'device link dropped', {
        deviceId: deviceSensitive(deviceId),
        errorMessage: safe(err ? err.message : 'clean disconnect (no error)'),
      })
      this.emitStatus({
        deviceId,
        state: err ? 'error' : 'dormant',
        generation: this.currentGeneration(deviceId),
        errorMessage: err?.message,
        lastChangeMonotonicMs: nowMonotonicMs(),
      })
    })
    this.disconnectSubs.set(deviceId, sub)
  }

  async connect(deviceId: string, options?: ConnectOptions): Promise<ConnectionStatus> {
    const manager = this.ensure()
    const timeoutMs = options?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    const startedAtMs = nowMonotonicMs()
    this.emitStatus({
      deviceId,
      state: 'connecting',
      generation: this.currentGeneration(deviceId),
      lastChangeMonotonicMs: nowMonotonicMs(),
    })
    try {
      // A pending (autoConnect) request must not carry a timeout — the
      // whole point is that the OS waits for the glove to advertise.
      const device: PlxDevice = await manager.connectToDevice(
        deviceId,
        options?.autoConnect === true ? { autoConnect: true } : { timeout: timeoutMs },
      )
      const generation = this.bumpGeneration(deviceId)
      // BALANCED priority, deliberately (2026-08-29, "the second glove
      // always dies"): requesting ConnectionPriority.High on BOTH glove
      // links asks this chip's LE scheduler for two 11-15ms intervals it
      // cannot service, and it sheds the newer link — the second glove
      // to connect died within seconds all day while the first held.
      // The Velocity Lab era ran balanced and held both gloves through
      // whole sessions. If A2DP congestion resurfaces (slow writes), the
      // revisit is High DURING one glove's init only, released to
      // balanced after — never High held on two links at once.
      try {
        await manager.requestConnectionPriorityForDevice(deviceId, ConnectionPriority.Balanced)
        logger.info('ble.connect.priority.ok', 'balanced connection priority requested', {
          deviceId: deviceSensitive(deviceId),
        })
      } catch (err) {
        logger.warn('ble.connect.priority.failed', 'connection priority request refused', {
          deviceId: deviceSensitive(deviceId),
          errorMessage: safe(err instanceof Error ? err.message : String(err)),
        })
      }
      if (options?.requestMtu) {
        try {
          await manager.requestMTUForDevice(deviceId, options.requestMtu)
        } catch {
          /* ignore MTU negotiation failures */
        }
      }
      this.watchDisconnect(manager, deviceId)
      const status: ConnectionStatus = {
        deviceId: device.id,
        state: 'ready',
        generation,
        lastChangeMonotonicMs: nowMonotonicMs(),
      }
      this.emitStatus(status)
      return status
    } catch (e) {
      // ble-plx puts the real diagnosis in fields we used to discard,
      // keeping only `.message` — which is a fixed template. That is why
      // a whole day of "Operation was cancelled" told us nothing: on
      // Android that string IS a connect timeout expiring (the library's
      // doFinally fires `cancelled()` before the timeout error can
      // surface), while "was disconnected" carries the GATT status that
      // says WHY the stack tore the link down. Log both, with the
      // duration that distinguishes a timeout from a real cancel.
      const err = e as {
        message?: string
        errorCode?: number
        attErrorCode?: number | null
        androidErrorCode?: number | null
        reason?: string | null
      }
      const durationMs = nowMonotonicMs() - startedAtMs
      // "Already connected" is not a failure — it is this app's own link
      // that JS lost track of (a Metro reload keeps native connections
      // while the store forgets them). Treating it as an error made
      // every pass cancel a perfectly good connection and rebuild it,
      // which on 2026-08-29 became an endless connect/cancel loop with
      // both gloves lit and unusable. Adopt the link instead.
      if (err?.errorCode === 203) {
        const generation = this.bumpGeneration(deviceId)
        this.watchDisconnect(manager, deviceId)
        const adopted: ConnectionStatus = {
          deviceId,
          state: 'ready',
          generation,
          lastChangeMonotonicMs: nowMonotonicMs(),
        }
        logger.info('ble.connect.adopted', 'adopted an existing link for this device', {
          deviceId: deviceSensitive(deviceId),
        })
        this.emitStatus(adopted)
        return adopted
      }
      logger.warn('ble.connect.failed', 'connect attempt failed', {
        deviceId: deviceSensitive(deviceId),
        errorMessage: safe(err?.message ?? String(e)),
        errorCode: safe(err?.errorCode ?? null),
        attErrorCode: safe(err?.attErrorCode ?? null),
        androidErrorCode: safe(err?.androidErrorCode ?? null),
        reason: safe(err?.reason ?? null),
        durationMs: safe(Math.round(durationMs)),
        timeoutMs: safe(options?.autoConnect === true ? null : timeoutMs),
      })
      // Best-effort cancel of the half-open attempt. Android (this
      // tablet's MediaTek stack in particular) keeps a pending GATT
      // handle after a failed direct connect — "Device was disconnected"
      // mid-handshake — and while that handle exists every later connect
      // to the same device fails too. Cancelling clears it; if there is
      // nothing to cancel this is a no-op.
      //
      // Skipped for an already-cancelled attempt (errorCode 2): the
      // library disposed that one itself and is mid-`gatt.close()`, so a
      // second teardown lands right before the next glove's connect.
      if (err?.errorCode !== 2) {
        try {
          await manager.cancelDeviceConnection(deviceId)
        } catch {
          /* nothing pending — fine */
        }
      }
      const status: ConnectionStatus = {
        deviceId,
        state: 'error',
        generation: this.currentGeneration(deviceId),
        errorMessage: (e as Error)?.message ?? String(e),
        lastChangeMonotonicMs: nowMonotonicMs(),
      }
      this.emitStatus(status)
      throw e
    }
  }

  async isConnected(deviceId: string): Promise<boolean> {
    if (!this.manager) return false
    try {
      return await this.manager.isDeviceConnected(deviceId)
    } catch {
      return false
    }
  }

  async disconnect(deviceId: string): Promise<void> {
    const sub = this.disconnectSubs.get(deviceId)
    if (sub) {
      sub.remove()
      this.disconnectSubs.delete(deviceId)
    }
    if (!this.manager) return
    try {
      await this.manager.cancelDeviceConnection(deviceId)
    } catch {
      /* already disconnected is fine */
    }
    this.emitStatus({
      deviceId,
      state: 'dormant',
      generation: this.currentGeneration(deviceId),
      lastChangeMonotonicMs: nowMonotonicMs(),
    })
  }

  onConnectionChange(deviceId: string, cb: (status: ConnectionStatus) => void): UnsubscribeFn {
    let set = this.connectionListeners.get(deviceId)
    if (!set) {
      set = new Set()
      this.connectionListeners.set(deviceId, set)
    }
    set.add(cb)
    return () => {
      const s = this.connectionListeners.get(deviceId)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) this.connectionListeners.delete(deviceId)
    }
  }

  async discoverAllServicesAndCharacteristics(deviceId: string): Promise<GattSnapshot> {
    const manager = this.ensure()
    await manager.discoverAllServicesAndCharacteristicsForDevice(deviceId)
    const services = await manager.servicesForDevice(deviceId)
    const mappedServices: GattServiceSnapshot[] = []
    for (const svc of services) {
      const chars = await manager.characteristicsForDevice(deviceId, svc.uuid)
      const mappedChars: GattCharacteristicSnapshot[] = []
      for (const c of chars) {
        let descriptors: Array<{ uuid: string }> = []
        try {
          const ds = await manager.descriptorsForDevice(deviceId, svc.uuid, c.uuid)
          descriptors = ds.map((d) => ({ uuid: d.uuid }))
        } catch {
          // Descriptor enumeration is best-effort — some peripherals refuse it.
        }
        mappedChars.push({
          uuid: c.uuid,
          properties: {
            read: c.isReadable,
            write: c.isWritableWithResponse,
            writeWithoutResponse: c.isWritableWithoutResponse,
            notify: c.isNotifiable,
            indicate: c.isIndicatable,
          },
          descriptors,
        })
      }
      mappedServices.push({ uuid: svc.uuid, characteristics: mappedChars })
    }
    return {
      deviceId,
      services: mappedServices,
      discoveredAtMonotonicMs: nowMonotonicMs(),
    }
  }

  /**
   * Subscribe to a characteristic's notifications.
   *
   * ## One native monitor per characteristic, many listeners
   *
   * Several parts of the app legitimately want the same characteristic at
   * once: the app-wide keepalive holds each glove's punch stream for the
   * app's whole life, and the Velocity Lab screens (Live, Probe, the BLE
   * spike) subscribe to the same one on the same facade. So a subscription is
   * shared: the first caller installs the native monitor, later callers on
   * the same connection JOIN it, and each handle removes only its own
   * listener. The native monitor goes away with its last listener.
   *
   * This used to be one slot per characteristic with no notion of who held
   * it. A second subscriber removed the incumbent's native monitor and took
   * the slot, and any handle's `unsubscribe()` removed whoever held the slot
   * at that moment. Opening Velocity Lab therefore silently killed the
   * keepalive's punch stream — which only re-arms on a connection change —
   * and every workout afterwards counted zero punches with both glove lamps
   * lit and nothing logged.
   *
   * Sharing also keeps persist-before-parse honest (CLAUDE.md rule 1): a
   * frame reaches the sink once, however many listeners there are.
   *
   * ## What is never joined
   *
   * A monitor installed on an earlier connection (`generation` is bumped on
   * every connect), or one whose callback has reported an error, is dead: it
   * will deliver nothing more. The next subscriber replaces it rather than
   * joining it — the one case the old "drop the prior subscription" rule was
   * right about, re-arming after a reconnect.
   */
  async monitorCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    onFrame: (frame: RawBleFrame) => void,
  ): Promise<SubscriptionHandle> {
    const manager = this.ensure()
    const key = subKey(deviceId, serviceUuid, characteristicUuid)
    // One object per subscription, so two owners passing the same function
    // still hold two distinct memberships.
    const listener: MonitorListener = { onFrame }

    const live = this.joinableMonitor(key, deviceId)
    if (live) return this.joinMonitor(key, live, listener)

    // Peek at the characteristic's properties to record the correct direction
    // in the SubscriptionResult, even if no frame ever arrives.
    let direction: 'notification' | 'indication' = 'notification'
    try {
      const chars = await manager.characteristicsForDevice(deviceId, serviceUuid)
      const match = chars.find((c) => c.uuid.toLowerCase() === characteristicUuid.toLowerCase())
      if (match) {
        direction = match.isNotifiable
          ? 'notification'
          : match.isIndicatable
            ? 'indication'
            : 'notification'
      }
    } catch {
      // Non-fatal — direction defaults to 'notification'.
    }

    // Re-check: another caller may have installed the monitor during the
    // await above. From here to `monitors.set` nothing yields, so two
    // installs for one key cannot interleave.
    const installedMeanwhile = this.joinableMonitor(key, deviceId)
    if (installedMeanwhile) return this.joinMonitor(key, installedMeanwhile, listener)

    // Whatever still holds the key is dead or belongs to a connection that
    // is gone. Its listeners were subscribed to that connection and get
    // nothing more, exactly as before; they re-subscribe if they want this one.
    const stale = this.monitors.get(key)
    if (stale) {
      logger.info('ble.monitor.replaced', 'replaced a stale monitor for this characteristic', {
        deviceId: deviceSensitive(deviceId),
        characteristicUuid: deviceSensitive(characteristicUuid),
        staleGeneration: safe(stale.generation),
        generation: safe(this.currentGeneration(deviceId)),
        staleListeners: safe(stale.listeners.size),
      })
      this.retireMonitor(key, stale)
    }

    // Definitive setup outcome — resolves on the FIRST callback fired by
    // ble-plx. If that callback carries an error, we know the CCCD write
    // failed. If it carries data, the subscription is confirmed working.
    // If the channel is quiet for SETUP_OUTCOME_QUIET_MS, we settle
    // optimistically (subscription accepted, just no data yet).
    let setupObserved = false
    let resolveOutcome: (r: SubscriptionResult) => void = () => {}
    const setupOutcome = new Promise<SubscriptionResult>((resolve) => {
      resolveOutcome = resolve
    })
    const result: SubscriptionResult = {
      serviceUuid,
      characteristicUuid,
      direction,
      success: true,
    }
    const entry: MonitorEntry = {
      sub: null,
      generation: this.currentGeneration(deviceId),
      listeners: new Set([listener]),
      result,
      setupOutcome,
      dead: false,
    }

    try {
      const sub = manager.monitorCharacteristicForDevice(
        deviceId,
        serviceUuid,
        characteristicUuid,
        (err, characteristic: PlxCharacteristic | null) => {
          // STAMP FIRST — before touching payload, err, or anything else (§11.9).
          const monotonicTimeMs = performance.now()
          const wallTimeIso = new Date().toISOString()

          if (err) {
            // An error ends this native monitor for good: the link dropped,
            // the CCCD write failed, or we removed it ourselves (ble-plx
            // reports that as "operation was cancelled"). Nothing may join
            // it after this.
            this.markMonitorDead(key, entry)
            if (!setupObserved) {
              setupObserved = true
              result.success = false
              result.errorMessage = err.message
              resolveOutcome(result)
            }
            return
          }

          if (!setupObserved) {
            // First callback carries data → subscription confirmed.
            setupObserved = true
            resolveOutcome(result)
          }

          if (!characteristic || characteristic.value == null) return
          const valueBase64 = characteristic.value
          let valueHex: string
          try {
            valueHex = base64ToHex(valueBase64)
          } catch {
            // Corrupt payload — drop this frame rather than crashing the sub.
            return
          }
          const frameDirection: 'notification' | 'indication' = characteristic.isNotifiable
            ? 'notification'
            : characteristic.isIndicatable
              ? 'indication'
              : direction
          const frame: RawBleFrame = {
            id: `${this.getCaptureId()}-${this.seq++}`,
            captureId: this.getCaptureId(),
            deviceId,
            handAtCapture: 'unknown',
            monotonicTimeMs,
            wallTimeIso,
            direction: frameDirection,
            serviceUuid,
            characteristicUuid,
            valueBase64,
            valueHex,
            connectionGeneration: this.currentGeneration(deviceId),
          }
          // PERSIST BEFORE DELIVERY (CLAUDE.md §1, §11.9, §12.4). The frame
          // reaches durable storage before any subscriber — decoder, probe UI
          // or spike harness — is even aware of it, and exactly once however
          // many of them are listening. Doing this here rather than at each
          // call site is what makes the guarantee structural: a new screen
          // cannot forget to persist. The sink's contract is that capture()
          // is synchronous and never throws, but we guard anyway because a
          // storage fault must never break frame delivery.
          try {
            this.frameSink?.capture(frame)
          } catch {
            /* sink contract violation — never break the native callback */
          }
          // A snapshot, so a listener that unsubscribes while handling a
          // frame cannot disturb the walk; and each in its own try, so one
          // listener throwing cannot starve the others of the frame.
          for (const each of [...entry.listeners]) {
            try {
              each.onFrame(frame)
            } catch (listenerErr) {
              logger.warn('ble.monitor.listener.threw', 'a frame listener threw', {
                deviceId: deviceSensitive(deviceId),
                characteristicUuid: deviceSensitive(characteristicUuid),
                errorMessage: safe(
                  listenerErr instanceof Error ? listenerErr.message : String(listenerErr),
                ),
              })
            }
          }
        },
      )
      entry.sub = sub
      // A monitor that failed synchronously is already dead; registering it
      // would only hand the next subscriber something to replace.
      if (!entry.dead) this.monitors.set(key, entry)
      // Settle optimistically after the quiet window if nothing else has.
      setTimeout(() => {
        if (!setupObserved) {
          setupObserved = true
          resolveOutcome(result)
        }
      }, SETUP_OUTCOME_QUIET_MS)
      return this.monitorHandle(key, entry, listener)
    } catch (e) {
      const failed: SubscriptionResult = {
        serviceUuid,
        characteristicUuid,
        direction,
        success: false,
        errorMessage: (e as Error)?.message ?? String(e),
      }
      resolveOutcome(failed)
      return {
        result: failed,
        setupOutcome: Promise.resolve(failed),
        unsubscribe: () => {
          /* no-op — nothing installed */
        },
      }
    }
  }

  /** The monitor on `key` a new subscriber may share, if there is one. */
  private joinableMonitor(key: SubKey, deviceId: string): MonitorEntry | null {
    const entry = this.monitors.get(key)
    if (!entry || entry.dead) return null
    // Installed on an earlier connection: the native side tore it down with
    // the link, whether or not an error callback ever said so.
    if (entry.generation !== this.currentGeneration(deviceId)) return null
    return entry
  }

  private joinMonitor(
    key: SubKey,
    entry: MonitorEntry,
    listener: MonitorListener,
  ): SubscriptionHandle {
    entry.listeners.add(listener)
    logger.info('ble.monitor.joined', 'a second listener joined an existing monitor', {
      characteristicUuid: deviceSensitive(entry.result.characteristicUuid),
      listeners: safe(entry.listeners.size),
    })
    return this.monitorHandle(key, entry, listener)
  }

  /**
   * The handle for one listener's membership of one monitor.
   *
   * `unsubscribe` removes THAT listener and nothing else. It is safe to call
   * twice, after the monitor died, or after a reconnect replaced the entry —
   * a handle from a dead connection must never reach the monitor that
   * succeeded it.
   */
  private monitorHandle(
    key: SubKey,
    entry: MonitorEntry,
    listener: MonitorListener,
  ): SubscriptionHandle {
    return {
      result: entry.result,
      setupOutcome: entry.setupOutcome,
      unsubscribe: () => {
        if (!entry.listeners.delete(listener)) return
        if (entry.listeners.size > 0) return
        this.retireMonitor(key, entry)
      },
    }
  }

  /** The native monitor reported an error: it will deliver nothing more. */
  private markMonitorDead(key: SubKey, entry: MonitorEntry): void {
    entry.dead = true
    // Identity, not key: the callback of a monitor we already replaced can
    // arrive late (ble-plx reports our own `remove()` as an error), and it
    // must not unregister its successor.
    if (this.monitors.get(key) === entry) this.monitors.delete(key)
  }

  /** Tear down a monitor nobody is listening to, or that is being replaced. */
  private retireMonitor(key: SubKey, entry: MonitorEntry): void {
    this.markMonitorDead(key, entry)
    try {
      entry.sub?.remove()
    } catch {
      /* already removed by the native side */
    }
  }

  async monitorAllNotifiable(
    snapshot: GattSnapshot,
    onFrame: (frame: RawBleFrame) => void,
  ): Promise<SubscriptionHandle[]> {
    const handles: SubscriptionHandle[] = []
    for (const svc of snapshot.services) {
      for (const c of svc.characteristics) {
        if (!(c.properties.notify || c.properties.indicate)) continue
        try {
          const h = await this.monitorCharacteristic(snapshot.deviceId, svc.uuid, c.uuid, onFrame)
          handles.push(h)
        } catch (e) {
          const failed = {
            result: {
              serviceUuid: svc.uuid,
              characteristicUuid: c.uuid,
              direction: (c.properties.notify ? 'notification' : 'indication') as
                'notification' | 'indication',
              success: false,
              errorMessage: (e as Error)?.message ?? String(e),
            },
            setupOutcome: Promise.resolve<SubscriptionResult>({
              serviceUuid: svc.uuid,
              characteristicUuid: c.uuid,
              direction: (c.properties.notify ? 'notification' : 'indication') as
                'notification' | 'indication',
              success: false,
              errorMessage: (e as Error)?.message ?? String(e),
            }),
            unsubscribe: () => {
              /* no-op */
            },
          }
          handles.push(failed)
        }
      }
    }
    return handles
  }

  async writeCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
    payload: { base64?: string; hex?: string },
    withResponse: boolean,
  ): Promise<WriteResult> {
    const manager = this.ensure()
    const hasBase64 = typeof payload.base64 === 'string' && payload.base64.length > 0
    const hasHex = typeof payload.hex === 'string' && payload.hex.length > 0
    if (hasBase64 === hasHex) {
      const errorMessage = 'writeCharacteristic requires exactly one of base64 or hex'
      return { success: false, bytesWritten: 0, durationMs: 0, errorMessage }
    }
    let base64Payload: string
    let bytesWritten = 0
    try {
      if (hasBase64) {
        base64Payload = payload.base64 as string
        // Decode to count bytes accurately (accounts for padding).
        bytesWritten = base64ToHex(base64Payload).length / 2
      } else {
        base64Payload = hexToBase64(payload.hex as string)
        bytesWritten = (payload.hex as string).replace(/[\s:]/g, '').length / 2
      }
    } catch (e) {
      return {
        success: false,
        bytesWritten: 0,
        durationMs: 0,
        errorMessage: (e as Error)?.message ?? String(e),
      }
    }
    logger.info('ble.write.attempt', 'developer-mode write to characteristic', {
      deviceId: deviceSensitive(deviceId),
      serviceUuid: deviceSensitive(serviceUuid),
      characteristicUuid: deviceSensitive(characteristicUuid),
      valueBase64: deviceSensitive(base64Payload),
      byteCount: safe(bytesWritten),
      withResponse: safe(withResponse),
    })
    const start = performance.now()
    try {
      if (withResponse) {
        await manager.writeCharacteristicWithResponseForDevice(
          deviceId,
          serviceUuid,
          characteristicUuid,
          base64Payload,
        )
      } else {
        await manager.writeCharacteristicWithoutResponseForDevice(
          deviceId,
          serviceUuid,
          characteristicUuid,
          base64Payload,
        )
      }
      const durationMs = performance.now() - start
      logger.info('ble.write.ok', 'developer-mode write completed', {
        deviceId: deviceSensitive(deviceId),
        serviceUuid: deviceSensitive(serviceUuid),
        characteristicUuid: deviceSensitive(characteristicUuid),
        byteCount: safe(bytesWritten),
        durationMs: safe(durationMs),
        withResponse: safe(withResponse),
      })
      return { success: true, bytesWritten, durationMs }
    } catch (e) {
      const durationMs = performance.now() - start
      const errorMessage = (e as Error)?.message ?? String(e)
      logger.warn('ble.write.err', 'developer-mode write failed', {
        deviceId: deviceSensitive(deviceId),
        serviceUuid: deviceSensitive(serviceUuid),
        characteristicUuid: deviceSensitive(characteristicUuid),
        byteCount: safe(bytesWritten),
        durationMs: safe(durationMs),
        withResponse: safe(withResponse),
        errorMessage: safe(errorMessage),
      })
      return { success: false, bytesWritten, durationMs, errorMessage }
    }
  }

  async readCharacteristic(
    deviceId: string,
    serviceUuid: string,
    characteristicUuid: string,
  ): Promise<ReadResult> {
    const manager = this.ensure()
    logger.info('ble.read.attempt', 'developer-mode read of characteristic', {
      deviceId: deviceSensitive(deviceId),
      serviceUuid: deviceSensitive(serviceUuid),
      characteristicUuid: deviceSensitive(characteristicUuid),
    })
    const start = performance.now()
    try {
      const characteristic = await manager.readCharacteristicForDevice(
        deviceId,
        serviceUuid,
        characteristicUuid,
      )
      const durationMs = performance.now() - start
      const valueBase64 = characteristic.value ?? undefined
      let valueHex: string | undefined
      if (valueBase64 != null) {
        try {
          valueHex = base64ToHex(valueBase64)
        } catch {
          valueHex = undefined
        }
      }
      logger.info('ble.read.ok', 'developer-mode read completed', {
        deviceId: deviceSensitive(deviceId),
        serviceUuid: deviceSensitive(serviceUuid),
        characteristicUuid: deviceSensitive(characteristicUuid),
        byteCount: safe(valueHex ? valueHex.length / 2 : 0),
        durationMs: safe(durationMs),
      })
      return { success: true, valueBase64, valueHex, durationMs }
    } catch (e) {
      const durationMs = performance.now() - start
      const errorMessage = (e as Error)?.message ?? String(e)
      logger.warn('ble.read.err', 'developer-mode read failed', {
        deviceId: deviceSensitive(deviceId),
        serviceUuid: deviceSensitive(serviceUuid),
        characteristicUuid: deviceSensitive(characteristicUuid),
        durationMs: safe(durationMs),
        errorMessage: safe(errorMessage),
      })
      return { success: false, durationMs, errorMessage }
    }
  }

  async destroy(): Promise<void> {
    await this.stopScan().catch(() => {})
    for (const entry of this.monitors.values()) {
      entry.dead = true
      try {
        entry.sub?.remove()
      } catch {
        /* ignore */
      }
    }
    this.monitors.clear()
    for (const sub of this.disconnectSubs.values()) {
      try {
        sub.remove()
      } catch {
        /* ignore */
      }
    }
    this.disconnectSubs.clear()
    this.connectionListeners.clear()
    if (this.manager) {
      try {
        this.manager.destroy()
      } catch {
        /* already destroyed */
      }
      this.manager = null
    }
    resetBleManagerSingleton()
  }
}
