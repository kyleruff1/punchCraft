/**
 * Reading — and only reading — what the official app reads (H13, H14).
 */
import { addSink, replaceSinks, type LogRecord } from '@diagnostics/logger'

import {
  DEVICE_INFORMATION_SERVICE_UUID,
  DEVICE_INFORMATION_STRINGS,
  SERIAL_NUMBER_UUID,
  SYSTEM_ID_UUID,
} from '../deviceInformation'
import { CHAR, FIGHTCAMP_SERVICE_UUID } from '../fightcamp-v1/FightCampV1Commands'
import { VENDOR_READ_ON_BEAT, VendorReads } from '../vendorReads'

const GLOVE = 'EA:69:2D:9C:FD:53'
const hexOf = (text: string): string =>
  [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')

function harness() {
  const values = new Map<string, string>([
    [CHAR.NOTIFY_STATUS, '10'],
    [SYSTEM_ID_UUID, '53fd9cfeff2d69ea'],
    [SERIAL_NUMBER_UUID, hexOf('SN-0042')],
    ...DEVICE_INFORMATION_STRINGS.map(({ label, uuid }) => [uuid, hexOf(label)] as const),
  ])
  const reads: Array<[service: string, characteristic: string]> = []
  let throwOn: string | null = null
  const reader = {
    readCharacteristic: async (_deviceId: string, service: string, characteristic: string) => {
      reads.push([service, characteristic])
      if (characteristic === throwOn) throw new Error('radio fault')
      const valueHex = values.get(characteristic)
      return valueHex === undefined
        ? { success: false, durationMs: 1, errorMessage: 'not found' }
        : { success: true, durationMs: 1, valueHex }
    },
  }
  const logs: LogRecord[] = []
  addSink({ write: (r) => void (r.code.startsWith('keepalive.') && logs.push(r)) })
  const vendor = new VendorReads(reader)
  return {
    vendor,
    reads,
    values,
    logs,
    throwOn: (uuid: string) => {
      throwOn = uuid
    },
    beat: () => vendor.onBeat(GLOVE, 'right'),
    logged: (code: string) =>
      logs
        .filter((r) => r.code === code)
        .map((r) => Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, f.value]))),
  }
}

afterEach(() => replaceSinks([]))

describe('VendorReads', () => {
  it('reads nothing on the first beat after a link comes ready', async () => {
    const h = harness()
    h.vendor.linkReady(GLOVE)
    await h.beat()
    expect(h.reads).toEqual([])
    expect(h.logs).toEqual([])
    expect(VENDOR_READ_ON_BEAT).toBe(2)
  })

  it('on the second: the status byte, then every Device Information value, in order', async () => {
    const h = harness()
    h.vendor.linkReady(GLOVE)
    await h.beat()
    await h.beat()
    expect(h.reads).toEqual([
      [FIGHTCAMP_SERVICE_UUID, CHAR.NOTIFY_STATUS],
      ...DEVICE_INFORMATION_STRINGS.map(({ uuid }) => [DEVICE_INFORMATION_SERVICE_UUID, uuid]),
      [DEVICE_INFORMATION_SERVICE_UUID, SERIAL_NUMBER_UUID],
      [DEVICE_INFORMATION_SERVICE_UUID, SYSTEM_ID_UUID],
    ])
    expect(h.logged('keepalive.status')).toEqual([
      { hand: 'right', valueHex: '10', bondGate: true, beat: 2 },
    ])
    expect(h.logged('keepalive.deviceInformation')).toEqual([
      {
        hand: 'right',
        manufacturer: 'manufacturer',
        model: 'model',
        hardwareRevision: 'hardware revision',
        firmwareRevision: 'firmware revision',
        softwareRevision: 'software revision',
        serialNumber: 'SN-0042',
        systemId: '53fd9cfeff2d69ea',
      },
    ])
  })

  it('marks what identifies the physical glove as device-sensitive', async () => {
    const h = harness()
    h.vendor.linkReady(GLOVE)
    await h.beat()
    await h.beat()
    const fields = h.logs.find((r) => r.code === 'keepalive.deviceInformation')!.fields
    expect(fields['serialNumber']?.class).toBe('device-sensitive')
    expect(fields['systemId']?.class).toBe('device-sensitive')
    expect(fields['firmwareRevision']?.class).toBe('safe')
  })

  it('afterwards reads only the status byte, and logs it only when it changes', async () => {
    const h = harness()
    h.vendor.linkReady(GLOVE)
    await h.beat()
    await h.beat()
    h.reads.length = 0

    await h.beat()
    expect(h.reads).toEqual([[FIGHTCAMP_SERVICE_UUID, CHAR.NOTIFY_STATUS]])
    expect(h.logged('keepalive.status')).toHaveLength(1)

    h.values.set(CHAR.NOTIFY_STATUS, '00')
    await h.beat()
    expect(h.logged('keepalive.status')[1]).toMatchObject({
      valueHex: '00',
      bondGate: false,
      beat: 4,
    })
    expect(h.logged('keepalive.deviceInformation')).toHaveLength(1)
  })

  it('starts over on the next link', async () => {
    const h = harness()
    h.vendor.linkReady(GLOVE)
    await h.beat()
    await h.beat()
    h.vendor.linkReady(GLOVE)
    h.reads.length = 0
    await h.beat()
    expect(h.reads).toEqual([])
    await h.beat()
    expect(h.logged('keepalive.status')).toHaveLength(2)
    expect(h.logged('keepalive.deviceInformation')).toHaveLength(2)
  })

  it('logs a value it could not read as missing, and reads the rest', async () => {
    const h = harness()
    h.values.delete(SERIAL_NUMBER_UUID)
    h.values.delete(CHAR.NOTIFY_STATUS)
    h.vendor.linkReady(GLOVE)
    await h.beat()
    await h.beat()
    await h.beat()
    expect(h.logged('keepalive.deviceInformation')[0]).toMatchObject({
      serialNumber: null,
      model: 'model',
    })
    // An unreadable status byte is said once, not on every beat.
    expect(h.logged('keepalive.status.unreadable')).toHaveLength(1)
  })

  it('never throws into the heartbeat', async () => {
    const h = harness()
    h.throwOn(CHAR.NOTIFY_STATUS)
    h.vendor.linkReady(GLOVE)
    await h.beat()
    await expect(h.beat()).resolves.toBeUndefined()
    expect(h.logged('keepalive.vendorReads.error')).toEqual([
      { hand: 'right', errorMessage: 'radio fault' },
    ])
  })

  it('does nothing for a glove whose link it was never told about', async () => {
    const h = harness()
    await h.beat()
    await h.beat()
    expect(h.reads).toEqual([])
  })

  it('touches the transport for reads and nothing else', async () => {
    // Handed a transport on which every other call throws.
    const touched: string[] = []
    const readOnly = new Proxy(
      {},
      {
        get: (_target, name) => {
          touched.push(String(name))
          if (name !== 'readCharacteristic') throw new Error(`unexpected ${String(name)}`)
          return async () => ({ success: true, durationMs: 1, valueHex: '10' })
        },
      },
    )
    const vendor = new VendorReads(readOnly as never)
    vendor.linkReady(GLOVE)
    await vendor.onBeat(GLOVE, 'right')
    await vendor.onBeat(GLOVE, 'right')
    expect(new Set(touched)).toEqual(new Set(['readCharacteristic']))
  })
})
