/**
 * Reading what the official app reads, and writing it down (H13, H14).
 *
 * The vendor's start-up reads two things punchCraft never has: the six
 * Device Information strings, and the status byte whose bit 4 it gates
 * "ready" on. Nothing here acts on either. It reads them, once per link, and
 * logs them — so that the next time the tablet runs with the gloves there is
 * a record of what the status byte was on a link that held, and of each
 * glove's firmware. The on-disk captures have neither: nothing ever asked.
 *
 * Reads only (CLAUDE.md rule 4 is about writes).
 *
 * ## Not at connect
 *
 * The vendor reads Device Information the moment it connects. This waits for
 * the SECOND heartbeat after a link comes ready — 20 to 40 s in — because the
 * connect is the part of this app's Bluetooth life that took longest to get
 * right, a link is busy then with the init plan and the glove's security
 * exchange (about 4 s in), and nothing about these reads can be watched from
 * a desk. The cost is half a minute before the values are logged.
 *
 * After that the status byte is read again on every beat and logged only
 * when it changes: whether it ever does is itself unknown.
 */
import type { BleManagerFacade } from '@ble/BleManagerFacade'
import { deviceSensitive, logger, safe } from '@diagnostics/logger'

import {
  DEVICE_INFORMATION_SERVICE_UUID,
  DEVICE_INFORMATION_STRINGS,
  SERIAL_NUMBER_UUID,
  SYSTEM_ID_UUID,
  textFromHex,
} from './deviceInformation'
import { CHAR, FIGHTCAMP_SERVICE_UUID } from './fightcamp-v1/FightCampV1Commands'
import { bondGateSet } from './fightcamp-v1/FightCampV1Status'

/** Which beat after `linkReady` does the full read. The first can be immediate. */
export const VENDOR_READ_ON_BEAT = 2

type Reader = Pick<BleManagerFacade, 'readCharacteristic'>

interface LinkState {
  beats: number
  identified: boolean
  /** The last status value logged; '' once "unreadable" has been said. */
  lastStatusHex: string | null
}

export class VendorReads {
  private readonly links = new Map<string, LinkState>()

  constructor(private readonly facade: Reader) {}

  /** A link came ready: start counting its beats afresh. */
  linkReady(deviceId: string): void {
    this.links.set(deviceId, { beats: 0, identified: false, lastStatusHex: null })
  }

  /**
   * Call after each heartbeat a connected glove was sent. Never throws: a
   * read that fails is logged and the beat carries on.
   */
  async onBeat(deviceId: string, hand: 'left' | 'right'): Promise<void> {
    const link = this.links.get(deviceId)
    if (!link) return
    link.beats += 1
    if (link.beats < VENDOR_READ_ON_BEAT) return
    try {
      await this.readStatus(deviceId, hand, link)
      if (!link.identified) {
        link.identified = true
        await this.readDeviceInformation(deviceId, hand)
      }
    } catch (err) {
      logger.warn('keepalive.vendorReads.error', 'vendor read threw', {
        hand: safe(hand),
        errorMessage: safe(err instanceof Error ? err.message : String(err)),
      })
    }
  }

  private async read(deviceId: string, serviceUuid: string, uuid: string): Promise<string | null> {
    const result = await this.facade.readCharacteristic(deviceId, serviceUuid, uuid)
    return result.success && result.valueHex !== undefined ? result.valueHex : null
  }

  private async readStatus(deviceId: string, hand: string, link: LinkState): Promise<void> {
    const valueHex = await this.read(deviceId, FIGHTCAMP_SERVICE_UUID, CHAR.NOTIFY_STATUS)
    if (valueHex === null) {
      // Say so once per link, not on every beat.
      if (link.lastStatusHex !== '') {
        link.lastStatusHex = ''
        logger.warn('keepalive.status.unreadable', 'status byte could not be read', {
          hand: safe(hand),
        })
      }
      return
    }
    if (valueHex === link.lastStatusHex) return
    link.lastStatusHex = valueHex
    logger.info('keepalive.status', 'glove status byte', {
      hand: safe(hand),
      valueHex: safe(valueHex),
      // H14: the vendor requires an OS bond when this is set, and writes
      // command 16 when it is clear. We do neither; this is the evidence.
      bondGate: safe(bondGateSet(valueHex)),
      beat: safe(link.beats),
    })
  }

  private async readDeviceInformation(deviceId: string, hand: string): Promise<void> {
    const text = async (uuid: string): Promise<string | null> => {
      const hex = await this.read(deviceId, DEVICE_INFORMATION_SERVICE_UUID, uuid)
      return hex === null ? null : textFromHex(hex)
    }
    const strings: Record<string, string | null> = {}
    for (const { label, uuid } of DEVICE_INFORMATION_STRINGS) strings[label] = await text(uuid)
    const serial = await text(SERIAL_NUMBER_UUID)
    const systemIdHex = await this.read(deviceId, DEVICE_INFORMATION_SERVICE_UUID, SYSTEM_ID_UUID)
    logger.info('keepalive.deviceInformation', 'glove device information', {
      hand: safe(hand),
      manufacturer: safe(strings['manufacturer']),
      model: safe(strings['model']),
      hardwareRevision: safe(strings['hardware revision']),
      // The vendor picks its record width from this one.
      firmwareRevision: safe(strings['firmware revision']),
      softwareRevision: safe(strings['software revision']),
      // Both identify the physical unit.
      serialNumber: deviceSensitive(serial),
      systemId: deviceSensitive(systemIdHex),
    })
  }
}
