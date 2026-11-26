/**
 * The PC glove check: bring a FightCamp v1 glove up from a browser and say
 * what happened.
 *
 * It answers one question — can this PC, through Web Bluetooth, do what the
 * tablet does? — by running the REAL path rather than a port of it:
 * `startPunchStream` with the real adapter and decoder, over
 * `BleManagerWebBluetoothImpl`, with the tablet keepalive's own heartbeat.
 * What works here is what a PC build of the app will use.
 *
 * This file has no DOM in it. `main.ts` draws the state; the tests drive it
 * with a fake facade.
 *
 * What it does to a glove, in order (CLAUDE.md rule 4 — every write here is
 * one the tablet app already sends):
 *   1. connect
 *   2. READ System ID, to check the glove against the button that was
 *      clicked — before the init plan writes a hand to it
 *   3. the adapter's init plan, through `startPunchStream`
 *   4. every 20 s, the keepalive's mode-normal byte and a battery READ
 *
 * Lessons carried over from the September PC spike (`tools/spikes/pc-ble`):
 * gloves are brought up one at a time (a connect that lands inside the other
 * glove's security procedure fails), and a link that dies 30-45 s after it
 * came ready is the not-bonded signature (H13, `src/ble/bondDiagnosis.ts`).
 */
import {
  UNBONDED_DROP_WINDOW_MS,
  bondVerdictAt,
  initialBondDiagnosis,
  linkDropped,
  linkReady,
  linkStillUp,
  type BondDiagnosis,
  type BondVerdict,
} from '@ble/bondDiagnosis'
import type { BleManagerFacade } from '@ble/BleManagerFacade'
import type { PickDeviceOptions, PickedDevice } from '@ble/BleManagerWebBluetoothImpl'
import type { ConnectionStatus, RawBleFrame } from '@ble/bleTypes'
import { KNOWN_TRACKERS, type KnownTracker } from '@ble/knownTrackers'
import type { LogRecord, LogSink } from '@diagnostics/logger'
import type { TrackerPunchEvent } from '@domain/punch/PunchEvent'
import { CHAR, FIGHTCAMP_SERVICE_UUID } from '@protocol/fightcamp-v1/FightCampV1Commands'
import {
  BATTERY_LEVEL_UUID,
  BATTERY_SERVICE_UUID,
  HEARTBEAT_INTERVAL_MS,
  MODE_NORMAL_BASE64,
} from '@protocol/fightcamp-v1/FightCampV1Keepalive'
import { startPunchStream, type PunchStreamController } from '@protocol/PunchStream'
import type { TrackerProtocolAdapter } from '@protocol/TrackerProtocolAdapter'

import {
  DEVICE_INFORMATION_SERVICE_UUID,
  DEVICE_INFORMATION_STRINGS,
  SYSTEM_ID_UUID,
  identifyGlove,
  textFromHex,
} from './gloveIdentity'

export type Hand = 'left' | 'right'

export type GlovePhase =
  | 'idle'
  | 'choosing'
  | 'waiting'
  | 'connecting'
  | 'identifying'
  | 'initialising'
  | 'streaming'
  | 'dropped'
  | 'wrong-glove'
  | 'failed'

export interface LinkRecord {
  readyAtMs: number
  endedAtMs: number | null
  /** Ended because Disconnect was clicked, or the page itself hung up. */
  byUser: boolean
  /** Ended cleanly inside the not-bonded window. */
  signature: boolean
}

export interface PunchRow {
  atMs: number
  /** Tracker-reported velocity: the record's raw byte (§4.3). */
  velocityRaw: number | null
  /** The same reading through the vendor's curve. Still tracker units. */
  velocity: number | null
  unit: string
  /** Arrival minus the tracker's own timestamp. */
  latencyMs: number | null
  /** Buffered on the glove and delivered late, per the decoder. */
  recovered: boolean
}

export interface TimelineEntry {
  atMs: number
  text: string
}

export interface GloveState {
  hand: Hand
  phase: GlovePhase
  deviceId: string | null
  deviceName: string | null
  linkUp: boolean
  links: LinkRecord[]
  bond: BondDiagnosis
  systemIdHex: string | null
  identified: KnownTracker | null
  deviceInformation: Record<string, string>
  subscribedChars: string[]
  initErrors: string[]
  trackerInfoHex: string | null
  batteryPct: number | null
  punches: PunchRow[]
  punchCount: number
  frames: number
  malformed: number
  unknown: number
  heartbeatsSent: number
  heartbeatsFailed: number
  timeline: TimelineEntry[]
  message: string | null
}

/** A facade that can also show the browser's chooser. */
export interface PickingFacade extends BleManagerFacade {
  pickDevice(options: PickDeviceOptions): Promise<PickedDevice>
}

export interface GloveCheckOptions {
  facade: PickingFacade
  adapter: TrackerProtocolAdapter
  /** Monotonic milliseconds. Defaults to `performance.now()`. */
  now?: () => number
  /** Called after every state change, so the page can redraw. */
  onChange?: () => void
}

/** Pause before reconnecting after a drop — long enough to read the line. */
export const RECONNECT_DELAY_MS = 1_500
/** A connect with no answer for this long is abandoned and retried. */
export const CONNECT_TIMEOUT_MS = 25_000
/** Reconnects in a row, without a link that held, before the page stops. */
export const MAX_RECONNECTS = 6
/** Punch rows kept per glove for the list; the count is never capped. */
export const MAX_PUNCH_ROWS = 500
/** Raw frames kept for download. Past this the oldest go, and it says so. */
export const MAX_CAPTURED_FRAMES = 50_000

/** What the chooser lists, and what the page may touch once connected. */
export const PICK_OPTIONS: PickDeviceOptions = {
  serviceUuids: [FIGHTCAMP_SERVICE_UUID],
  // H01: the gloves advertise the service AND the truncated name. Either
  // matches, in case a firmware or a bond state advertises only one.
  namePrefixes: ['FightCam'],
  optionalServiceUuids: [
    FIGHTCAMP_SERVICE_UUID,
    BATTERY_SERVICE_UUID,
    DEVICE_INFORMATION_SERVICE_UUID,
  ],
}

const otherHand = (hand: Hand): Hand => (hand === 'left' ? 'right' : 'left')
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

export const UNBONDED_WINDOW_TEXT = `${UNBONDED_DROP_WINDOW_MS.min / 1000}-${
  UNBONDED_DROP_WINDOW_MS.max / 1000
} s`

interface Glove extends GloveState {
  /** The user wants this glove connected (cleared by Disconnect). */
  wanted: boolean
  /** Bumped on every `ready`, so a bring-up can tell its link from a later one. */
  linkSerial: number
  identityTried: boolean
  reconnects: number
  saidHolding: boolean
  phaseAfterHangUp: GlovePhase | null
  controller: PunchStreamController | null
  unwatch: (() => void) | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

function freshGlove(hand: Hand): Glove {
  return {
    hand,
    phase: 'idle',
    deviceId: null,
    deviceName: null,
    linkUp: false,
    links: [],
    bond: initialBondDiagnosis(),
    systemIdHex: null,
    identified: null,
    deviceInformation: {},
    subscribedChars: [],
    initErrors: [],
    trackerInfoHex: null,
    batteryPct: null,
    punches: [],
    punchCount: 0,
    frames: 0,
    malformed: 0,
    unknown: 0,
    heartbeatsSent: 0,
    heartbeatsFailed: 0,
    timeline: [],
    message: null,
    wanted: false,
    linkSerial: 0,
    identityTried: false,
    reconnects: 0,
    saidHolding: false,
    phaseAfterHangUp: null,
    controller: null,
    unwatch: null,
    reconnectTimer: null,
  }
}

export class GloveCheck {
  private readonly facade: PickingFacade
  private readonly adapter: TrackerProtocolAdapter
  private readonly now: () => number
  private readonly onChange: () => void
  private readonly gloves: Record<Hand, Glove> = {
    left: freshGlove('left'),
    right: freshGlove('right'),
  }
  private readonly captured: RawBleFrame[] = []
  private droppedFrames = 0
  /** Bring-ups run one after another, never side by side. */
  private queue: Promise<void> = Promise.resolve()
  /** The glove whose bring-up is running, for attributing log lines. */
  private active: Hand | null = null
  private beat: ReturnType<typeof setInterval> | null = null
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(options: GloveCheckOptions) {
    this.facade = options.facade
    this.adapter = options.adapter
    this.now = options.now ?? (() => performance.now())
    this.onChange = options.onChange ?? (() => undefined)
    // Rule 1: the transport hands every frame here before anything decodes
    // it. A page has no database, so "persisted" means kept for download.
    this.facade.setFrameSink({ capture: (frame) => this.capture(frame) })
  }

  /** Start the heartbeat and the once-a-second look at the links. */
  start(): void {
    if (this.beat) return
    this.beat = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS)
    this.ticker = setInterval(() => this.tick(), 1_000)
  }

  stop(): void {
    if (this.beat) clearInterval(this.beat)
    if (this.ticker) clearInterval(this.ticker)
    this.beat = null
    this.ticker = null
    for (const g of Object.values(this.gloves)) {
      if (g.reconnectTimer) clearTimeout(g.reconnectTimer)
      g.reconnectTimer = null
    }
  }

  glove(hand: Hand): GloveState {
    return this.gloves[hand]
  }

  /** The verdict right now, counting a link that is still up. */
  verdict(hand: Hand): BondVerdict {
    return bondVerdictAt(this.gloves[hand].bond, this.now())
  }

  /** How long the current link has been up, or null without one. */
  linkAgeMs(hand: Hand): number | null {
    const g = this.gloves[hand]
    const link = g.links[g.links.length - 1]
    return g.linkUp && link ? this.now() - link.readyAtMs : null
  }

  canConnect(hand: Hand): boolean {
    const phase = this.gloves[hand].phase
    const choosing = Object.values(this.gloves).some((g) => g.phase === 'choosing')
    return !choosing && (phase === 'idle' || phase === 'failed' || phase === 'wrong-glove')
  }

  canDisconnect(hand: Hand): boolean {
    const g = this.gloves[hand]
    return g.wanted && g.phase !== 'choosing'
  }

  capturedFrames(): { frames: readonly RawBleFrame[]; dropped: number } {
    return { frames: this.captured, dropped: this.droppedFrames }
  }

  /**
   * Connect a glove as `hand`. MUST be called from a click: the first thing
   * it does is open the browser's chooser, which needs the gesture.
   */
  async connect(hand: Hand): Promise<void> {
    if (!this.canConnect(hand)) return
    const g = this.gloves[hand]
    g.phase = 'choosing'
    g.message = null
    this.note(g, 'chooser opened')
    let picked: PickedDevice
    try {
      picked = await this.facade.pickDevice(PICK_OPTIONS)
    } catch (err) {
      g.phase = 'idle'
      g.message = `No glove chosen (${messageOf(err)}).`
      this.note(g, `chooser closed without a glove: ${messageOf(err)}`)
      return
    }
    const other = this.gloves[otherHand(hand)]
    if (other.deviceId === picked.deviceId && other.wanted) {
      g.phase = 'idle'
      g.message = `That glove is already connected as the ${other.hand} glove. Wake the other one and try again.`
      this.note(g, 'the chosen glove is already in use as the other hand')
      return
    }
    if (g.deviceId !== picked.deviceId) {
      g.unwatch?.()
      g.unwatch = null
      g.identityTried = false
      g.identified = null
      g.systemIdHex = null
      g.deviceInformation = {}
      g.bond = initialBondDiagnosis()
    }
    g.deviceId = picked.deviceId
    g.deviceName = picked.name ?? null
    g.wanted = true
    g.reconnects = 0
    g.unwatch ??= this.facade.onConnectionChange(picked.deviceId, (s) => this.onConnection(g, s))
    this.note(g, `chose "${g.deviceName ?? 'unnamed'}"`)
    await this.enqueueBringUp(g)
  }

  /** Hang up and stop reconnecting. */
  async disconnect(hand: Hand): Promise<void> {
    const g = this.gloves[hand]
    if (!g.deviceId) return
    g.wanted = false
    if (g.reconnectTimer) clearTimeout(g.reconnectTimer)
    g.reconnectTimer = null
    this.note(g, 'disconnect requested')
    const wasUp = g.linkUp
    await this.facade.disconnect(g.deviceId)
    // With no link up there is no drop event to settle the phase.
    if (!wasUp && g.phase !== 'wrong-glove') g.phase = 'idle'
    this.changed()
  }

  // -- bring-up ---------------------------------------------------------------

  private enqueueBringUp(g: Glove): Promise<void> {
    g.phase = 'waiting'
    this.changed()
    const run = this.queue.then(() => this.bringUp(g))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async bringUp(g: Glove): Promise<void> {
    const deviceId = g.deviceId
    if (!g.wanted || !deviceId) return
    this.active = g.hand
    try {
      g.phase = 'connecting'
      this.note(g, 'connecting')
      const startedAt = this.now()
      await this.connectWithTimeout(deviceId)
      const serial = g.linkSerial
      const alive = (): boolean => g.wanted && g.linkUp && g.linkSerial === serial
      this.note(g, `connected in ${seconds(this.now() - startedAt)}`)
      if (!alive()) return

      if (!g.identityTried) {
        g.phase = 'identifying'
        this.changed()
        await this.identify(g, deviceId)
        if (!alive()) return
      }

      g.phase = 'initialising'
      this.note(g, `running the init plan as the ${g.hand} glove`)
      const controller = await startPunchStream({
        facade: this.facade,
        deviceId,
        adapter: this.adapter,
        hand: g.hand,
        onEvent: (event) => this.onPunch(g, event),
        onDecodeMeta: (meta) => {
          if (meta.malformed) g.malformed += 1
          if (meta.unknown) g.unknown += 1
        },
      })
      const state = controller.getState()
      g.subscribedChars = state.subscribedChars
      g.initErrors = state.initErrors
      g.trackerInfoHex = state.deviceInfo[CHAR.DEVICE_INFO_READ] ?? null
      this.note(
        g,
        `init plan finished: ${state.subscribedChars.length} subscriptions, ` +
          (state.initErrors.length === 0 ? 'no errors' : `errors: ${state.initErrors.join('; ')}`),
      )
      if (!alive()) {
        await controller.stop()
        return
      }
      g.controller = controller
      g.phase = 'streaming'
      this.changed()
      await this.readBattery(g, deviceId)
      await this.readDeviceInformation(g, deviceId)
    } catch (err) {
      this.note(g, `could not bring the link up: ${messageOf(err)}`)
      if (g.wanted && !g.linkUp) {
        g.phase = 'dropped'
        g.message = `Could not connect (${messageOf(err)}).`
        this.scheduleReconnect(g)
      }
    } finally {
      this.active = null
      this.changed()
    }
  }

  private async connectWithTimeout(deviceId: string): Promise<void> {
    const attempt = this.facade.connect(deviceId)
    // If the timeout wins, the abandoned attempt still settles — quietly.
    attempt.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void this.facade.disconnect(deviceId)
        reject(new Error(`no answer in ${seconds(CONNECT_TIMEOUT_MS)}`))
      }, CONNECT_TIMEOUT_MS)
    })
    try {
      await Promise.race([attempt, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Read System ID and check the glove against the button that was clicked.
   * A glove known to be the OTHER hand is hung up before anything is written.
   */
  private async identify(g: Glove, deviceId: string): Promise<void> {
    g.identityTried = true
    const read = await this.facade.readCharacteristic(
      deviceId,
      DEVICE_INFORMATION_SERVICE_UUID,
      SYSTEM_ID_UUID,
    )
    if (!read.success || !read.valueHex) {
      this.note(
        g,
        `System ID not readable (${read.errorMessage ?? 'no value'}); trusting the button`,
      )
      return
    }
    g.systemIdHex = read.valueHex
    g.identified = identifyGlove(read.valueHex, KNOWN_TRACKERS)
    if (!g.identified) {
      this.note(g, `System ID ${read.valueHex} carries no known address; trusting the button`)
      return
    }
    const known = g.identified
    this.note(g, `System ID carries ${known.address}: the ${known.hand} glove (${known.color})`)
    if (known.hand === g.hand) return
    g.wanted = false
    g.identityTried = false
    g.phaseAfterHangUp = 'wrong-glove'
    g.message =
      `That is the ${known.hand} glove (${known.color}), not the ${g.hand} one. ` +
      `Nothing was written to it. Use the "Connect ${known.hand} glove" button.`
    this.note(g, 'wrong glove for this button: hanging up before the init plan')
    await this.facade.disconnect(deviceId)
  }

  // -- the link ---------------------------------------------------------------

  private onConnection(g: Glove, status: ConnectionStatus): void {
    const at = this.now()
    if (status.state === 'ready') {
      g.linkUp = true
      g.linkSerial += 1
      g.saidHolding = false
      g.message = null
      g.bond = linkReady(g.bond, at)
      g.links.push({ readyAtMs: at, endedAtMs: null, byUser: false, signature: false })
      this.note(g, `link ready (connection ${g.links.length})`)
    } else if (status.state === 'dormant' || status.state === 'error') {
      // A connect that never came up is reported by the bring-up, not here.
      if (!g.linkUp) return
      g.linkUp = false
      const link = g.links[g.links.length - 1]
      const heldMs = link ? at - link.readyAtMs : 0
      const byUser = !g.wanted
      // A hang-up the page asked for proves nothing about bonding.
      const before = g.bond.signatureDrops
      g.bond = linkDropped(g.bond, at, status.state === 'dormant' && !byUser)
      const signature = g.bond.signatureDrops > before
      if (link) Object.assign(link, { endedAtMs: at, byUser, signature })
      void g.controller?.stop()
      g.controller = null
      if (byUser) {
        this.note(g, `hung up after ${seconds(heldMs)}`)
        g.phase = g.phaseAfterHangUp ?? 'idle'
        g.phaseAfterHangUp = null
      } else {
        this.note(
          g,
          `link dropped after ${seconds(heldMs)}` +
            (signature ? ` — inside ${UNBONDED_WINDOW_TEXT}, where an unbonded glove drops` : ''),
        )
        g.phase = 'dropped'
        this.scheduleReconnect(g)
      }
    }
    this.changed()
  }

  private scheduleReconnect(g: Glove): void {
    if (g.bond.verdict === 'probably-unbonded') {
      g.phase = 'failed'
      g.message = `Stopped reconnecting: it dropped inside ${UNBONDED_WINDOW_TEXT} ${g.bond.signatureDrops} times in a row.`
      this.note(g, 'not reconnecting: the not-bonded signature repeated')
      return
    }
    if (g.reconnects >= MAX_RECONNECTS) {
      g.phase = 'failed'
      g.message = `Stopped after ${MAX_RECONNECTS} reconnects without a link that held. Wake the glove and connect again.`
      this.note(g, 'not reconnecting: too many attempts in a row')
      return
    }
    g.reconnects += 1
    g.reconnectTimer = setTimeout(() => {
      g.reconnectTimer = null
      if (!g.wanted || g.linkUp) return
      this.note(g, `reconnecting (attempt ${g.reconnects})`)
      void this.enqueueBringUp(g)
    }, RECONNECT_DELAY_MS)
  }

  /** Once a second: notice a link that has outlived the not-bonded window. */
  private tick(): void {
    const at = this.now()
    for (const g of Object.values(this.gloves)) {
      if (!g.linkUp) continue
      g.bond = linkStillUp(g.bond, at)
      if (g.bond.verdict === 'holding' && !g.saidHolding) {
        g.saidHolding = true
        g.reconnects = 0
        this.note(g, `held past ${UNBONDED_DROP_WINDOW_MS.max / 1000} s: the link is secure`)
      }
    }
    this.changed()
  }

  /**
   * The tablet keepalive's beat, from the same constants: mode-normal to
   * COMMAND1, then a battery read. Nothing else is ever written from here.
   */
  private async heartbeat(): Promise<void> {
    for (const g of Object.values(this.gloves)) {
      const deviceId = g.deviceId
      if (g.phase !== 'streaming' || !deviceId) continue
      const result = await this.facade.writeCharacteristic(
        deviceId,
        FIGHTCAMP_SERVICE_UUID,
        CHAR.COMMAND1,
        { base64: MODE_NORMAL_BASE64 },
        true,
      )
      if (result.success) {
        g.heartbeatsSent += 1
      } else {
        g.heartbeatsFailed += 1
        this.note(g, `heartbeat write failed: ${result.errorMessage ?? 'unknown'}`)
      }
      await this.readBattery(g, deviceId)
    }
    this.changed()
  }

  // -- what comes back ----------------------------------------------------------

  private onPunch(g: Glove, event: TrackerPunchEvent): void {
    const arrivalMs = Date.parse(event.receivedWallTimeIso)
    const latencyMs =
      typeof event.trackerTimestampMs === 'number' && Number.isFinite(arrivalMs)
        ? arrivalMs - event.trackerTimestampMs
        : null
    g.punchCount += 1
    g.punches.push({
      atMs: event.receivedMonotonicTimeMs,
      velocityRaw: event.velocityRaw ?? null,
      velocity: event.velocityCalibrated ?? null,
      unit: event.velocityUnit,
      latencyMs,
      recovered: event.recovered,
    })
    if (g.punches.length > MAX_PUNCH_ROWS) g.punches.shift()
    this.changed()
  }

  private async readBattery(g: Glove, deviceId: string): Promise<void> {
    const read = await this.facade.readCharacteristic(
      deviceId,
      BATTERY_SERVICE_UUID,
      BATTERY_LEVEL_UUID,
    )
    if (!read.success || !read.valueHex) return
    const pct = Number.parseInt(read.valueHex.slice(0, 2), 16)
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) g.batteryPct = pct
  }

  private async readDeviceInformation(g: Glove, deviceId: string): Promise<void> {
    for (const { label, uuid } of DEVICE_INFORMATION_STRINGS) {
      if (g.deviceInformation[label] !== undefined) continue
      const read = await this.facade.readCharacteristic(
        deviceId,
        DEVICE_INFORMATION_SERVICE_UUID,
        uuid,
      )
      if (read.success && read.valueHex) g.deviceInformation[label] = textFromHex(read.valueHex)
    }
  }

  private capture(frame: RawBleFrame): void {
    this.captured.push(frame)
    if (this.captured.length > MAX_CAPTURED_FRAMES) {
      this.captured.shift()
      this.droppedFrames += 1
    }
    for (const g of Object.values(this.gloves)) {
      if (g.deviceId === frame.deviceId) g.frames += 1
    }
  }

  /**
   * A log sink: the punch stream reports each init step as it happens, and
   * this puts those lines on the timeline of the glove being brought up.
   * Only fields the logger classifies `safe` are shown.
   */
  logSink(): LogSink {
    return {
      write: (record: LogRecord): void => {
        if (!record.code.startsWith('punchstream.') || this.active === null) return
        const field = (name: string): unknown =>
          record.fields[name]?.class === 'safe' ? record.fields[name]?.value : undefined
        const duration = field('durationMs')
        const parts = [
          field('label') ?? field('characteristicUuid') ?? field('labels'),
          typeof duration === 'number' ? `${Math.round(duration)} ms` : undefined,
          field('errorMessage'),
        ].filter((part) => part !== undefined && part !== '')
        this.note(
          this.gloves[this.active],
          parts.length > 0 ? `${record.message}: ${parts.join(' · ')}` : record.message,
        )
        this.changed()
      },
    }
  }

  private note(g: Glove, text: string): void {
    g.timeline.push({ atMs: this.now(), text })
  }

  private changed(): void {
    this.onChange()
  }
}
