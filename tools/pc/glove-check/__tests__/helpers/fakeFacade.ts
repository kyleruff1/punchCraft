/**
 * A scriptable stand-in for the Web Bluetooth transport, for driving the glove
 * check without a browser. It keeps the transport's two promises: a frame
 * reaches the sink before any listener, and nothing is written unless asked.
 */
import type { SubscriptionHandle } from '@ble/BleManagerFacade'
import type { PickDeviceOptions, PickedDevice } from '@ble/BleManagerWebBluetoothImpl'
import type {
  ConnectionStatus,
  GattSnapshot,
  RawBleFrame,
  RawFrameSink,
  ReadResult,
  WriteResult,
} from '@ble/bleTypes'
import { hexToBase64 } from '@ble/bleBytes'
import { CHAR, FIGHTCAMP_SERVICE_UUID } from '@protocol/fightcamp-v1/FightCampV1Commands'

import type { PickingFacade } from '../../gloveCheck'

export interface FakeWrite {
  deviceId: string
  characteristicUuid: string
  hex: string
}

export function fakeFacade(now: () => number) {
  const picks: Array<PickedDevice | Error> = []
  const pickRequests: PickDeviceOptions[] = []
  const connected = new Set<string>()
  const generation = new Map<string, number>()
  const listeners = new Map<string, Set<(s: ConnectionStatus) => void>>()
  const monitors = new Map<string, Set<(f: RawBleFrame) => void>>()
  const reads = new Map<string, string>()
  const writes: FakeWrite[] = []
  /** Every read and write in the order it was asked for: `read:<uuid>`. */
  const ops: string[] = []
  const connectFailures: Error[] = []
  const hangingConnects = new Map<string, (err: Error) => void>()
  let hangNextConnect = false
  let sink: RawFrameSink | null = null
  let seq = 0

  const emit = (deviceId: string, state: ConnectionStatus['state'], errorMessage?: string) => {
    const status: ConnectionStatus = {
      deviceId,
      state,
      generation: generation.get(deviceId) ?? 0,
      lastChangeMonotonicMs: now(),
      ...(errorMessage ? { errorMessage } : {}),
    }
    for (const cb of [...(listeners.get(deviceId) ?? [])]) cb(status)
    return status
  }
  const dropLink = (deviceId: string) => {
    if (!connected.delete(deviceId)) return
    for (const key of [...monitors.keys()]) if (key.startsWith(`${deviceId}|`)) monitors.delete(key)
    emit(deviceId, 'dormant')
  }
  const notConnected = { success: false, durationMs: 1, errorMessage: 'not connected' }

  const facade: PickingFacade = {
    setCaptureIdProvider: () => undefined,
    setFrameSink: (next) => {
      sink = next
    },
    isReady: async () => true,
    onAdapterStateChange: () => () => undefined,
    scan: () => Promise.reject(new Error('cannot scan')),
    stopScan: async () => undefined,
    pickDevice: async (options) => {
      pickRequests.push(options)
      const next = picks.shift()
      if (!next) throw new Error('User cancelled the requestDevice() chooser.')
      if (next instanceof Error) throw next
      return next
    },
    connect: async (deviceId) => {
      emit(deviceId, 'connecting')
      const failure = connectFailures.shift()
      if (failure) {
        emit(deviceId, 'error', failure.message)
        throw failure
      }
      if (hangNextConnect) {
        hangNextConnect = false
        await new Promise<never>((_, reject) => hangingConnects.set(deviceId, reject))
      }
      generation.set(deviceId, (generation.get(deviceId) ?? 0) + 1)
      connected.add(deviceId)
      return emit(deviceId, 'ready')
    },
    disconnect: async (deviceId) => {
      const abort = hangingConnects.get(deviceId)
      hangingConnects.delete(deviceId)
      abort?.(new Error('connect aborted'))
      dropLink(deviceId)
    },
    isConnected: async (deviceId) => connected.has(deviceId),
    onConnectionChange: (deviceId, cb) => {
      const set = listeners.get(deviceId) ?? new Set()
      set.add(cb)
      listeners.set(deviceId, set)
      return () => set.delete(cb)
    },
    discoverAllServicesAndCharacteristics: async (deviceId): Promise<GattSnapshot> => {
      if (!connected.has(deviceId)) throw new Error('device is not connected')
      return { deviceId, services: [], discoveredAtMonotonicMs: now() }
    },
    monitorCharacteristic: async (deviceId, serviceUuid, characteristicUuid, onFrame) => {
      if (!connected.has(deviceId)) throw new Error('device is not connected')
      const key = `${deviceId}|${characteristicUuid}`
      const set = monitors.get(key) ?? new Set()
      set.add(onFrame)
      monitors.set(key, set)
      const result = {
        serviceUuid,
        characteristicUuid,
        direction: 'indication' as const,
        success: true,
      }
      const handle: SubscriptionHandle = {
        result,
        setupOutcome: Promise.resolve(result),
        unsubscribe: () => set.delete(onFrame),
      }
      return handle
    },
    monitorAllNotifiable: async () => [],
    writeCharacteristic: async (
      deviceId,
      _s,
      characteristicUuid,
      payload,
    ): Promise<WriteResult> => {
      if (!connected.has(deviceId)) return { ...notConnected, bytesWritten: 0 }
      const hex = payload.hex ?? (payload.base64 === 'AQ==' ? '01' : `b64:${payload.base64}`)
      writes.push({ deviceId, characteristicUuid, hex })
      ops.push(`write:${characteristicUuid}`)
      return { success: true, bytesWritten: hex.length / 2, durationMs: 1 }
    },
    readCharacteristic: async (deviceId, _service, characteristicUuid): Promise<ReadResult> => {
      const valueHex = reads.get(`${deviceId}|${characteristicUuid}`)
      ops.push(`read:${characteristicUuid}`)
      if (!connected.has(deviceId)) return notConnected
      if (valueHex === undefined) return { ...notConnected, errorMessage: 'not readable' }
      return { success: true, durationMs: 1, valueHex, valueBase64: hexToBase64(valueHex) }
    },
    destroy: async () => undefined,
  }

  return {
    facade,
    writes,
    ops,
    pickRequests,
    willPick: (device: PickedDevice | Error) => picks.push(device),
    setRead: (deviceId: string, characteristicUuid: string, valueHex: string) =>
      reads.set(`${deviceId}|${characteristicUuid}`, valueHex),
    failNextConnect: (err: Error) => connectFailures.push(err),
    hangNextConnect: () => {
      hangNextConnect = true
    },
    drop: dropLink,
    isConnected: (deviceId: string) => connected.has(deviceId),
    /** Deliver a data-stream frame the way the transport does: sink first. */
    emitFrame: (
      deviceId: string,
      valueHex: string,
      wallTimeIso: string,
      characteristicUuid: string = CHAR.DATA_STREAM,
    ) => {
      const frame: RawBleFrame = {
        id: `f-${seq++}`,
        captureId: 'test',
        deviceId,
        handAtCapture: 'unknown',
        monotonicTimeMs: now(),
        wallTimeIso,
        direction: 'indication',
        serviceUuid: FIGHTCAMP_SERVICE_UUID,
        characteristicUuid,
        valueBase64: hexToBase64(valueHex),
        valueHex,
        connectionGeneration: generation.get(deviceId) ?? 0,
      }
      sink?.capture(frame)
      for (const cb of [...(monitors.get(`${deviceId}|${characteristicUuid}`) ?? [])]) cb(frame)
    },
  }
}
