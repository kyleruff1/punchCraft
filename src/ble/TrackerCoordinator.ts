/**
 * TrackerCoordinator — orchestrates the two tracker slots (left / right).
 *
 * Consumes ONLY the BleManagerFacade surface (§11.4, §15.1) and drives the
 * useTrackerStore in reaction to facade events. Owns per-slot cleanup for
 * the onConnectionChange subscriptions so disconnectSlot() leaves nothing
 * dangling.
 *
 * Terminology note (§0): if this coordinator ever surfaces a per-punch value
 * it is a "tracker-reported velocity" — never force / power / energy.
 */
import {
  getBleManager,
  type BleManagerFacade,
  type ConnectOptions,
  type UnsubscribeFn,
} from './BleManagerFacade'
import { TrackerScanner, type TrackerScannerRunOptions } from './TrackerScanner'
import type { AdvertisementSnapshot, ConnectionStatus, Hand } from './bleTypes'
import {
  UNBONDED_DROP_WINDOW_MS,
  initialBondDiagnosis,
  linkAbandoned,
  linkDropped,
  linkReady,
  linkStillUp,
  type BondDiagnosis,
} from './bondDiagnosis'
import {
  assignSlot,
  clearSlot,
  getTrackerSlots,
  setSlotBondVerdict,
  setSlotConnected,
  setSlotConnecting,
} from '@/state/useTrackerStore'
import { deviceSensitive, logger, safe } from '@/diagnostics/logger'

export type TrackerAggregate = 'noneReady' | 'leftOnly' | 'rightOnly' | 'bothReady'
export type TrackerSlotHand = Exclude<Hand, 'unknown'>

interface SlotBinding {
  deviceId: string
  unsubscribe: UnsubscribeFn
}

export class TrackerCoordinator {
  private readonly scanner: TrackerScanner
  private readonly bindings: Record<TrackerSlotHand, SlotBinding | null> = {
    left: null,
    right: null,
  }
  /**
   * How each glove's links have ended, by device (H13). Not by slot: a slot
   * is torn down and rebuilt on every reconnect, and "it dropped at 37 s
   * again" is only visible across two of them.
   */
  private readonly bond = new Map<string, BondDiagnosis>()
  private readonly holdTimers: Record<TrackerSlotHand, ReturnType<typeof setTimeout> | null> = {
    left: null,
    right: null,
  }

  constructor(private readonly facade: BleManagerFacade) {
    this.scanner = new TrackerScanner(facade)
  }

  async scan(options: TrackerScannerRunOptions = {}): Promise<AdvertisementSnapshot[]> {
    return this.scanner.run(options)
  }

  /** Native-stack ground truth for the auto-connect probe. */
  async isDeviceConnected(deviceId: string): Promise<boolean> {
    return this.facade.isConnected(deviceId)
  }

  async connectSlot(
    hand: TrackerSlotHand,
    deviceId: string,
    name?: string,
    options?: ConnectOptions,
  ): Promise<void> {
    // Tear down any previous binding for this slot first — reassigning a
    // slot to a new device must not leak the old change-listener.
    this.tearDownBinding(hand)

    assignSlot(hand, deviceId, name)
    setSlotConnecting(hand, true)

    const unsubscribe = this.facade.onConnectionChange(deviceId, (status: ConnectionStatus) => {
      const ready = status.state === 'ready' || status.state === 'streaming'
      setSlotConnected(hand, ready)
      if (status.state === 'error') {
        setSlotConnecting(hand, false, status.errorMessage)
      }
      this.noteBond(hand, deviceId, status)
    })
    this.bindings[hand] = { deviceId, unsubscribe }

    try {
      const status = await this.facade.connect(deviceId, options)
      const ready = status.state === 'ready' || status.state === 'streaming'
      setSlotConnected(hand, ready)
      // The listener above normally sees this first; a transport that only
      // resolves the promise is covered here. Idempotent either way.
      this.noteBond(hand, deviceId, status)
      setSlotConnecting(hand, false)
      logger.info('ble.slot.connect.ok', 'Tracker slot connected', {
        hand: safe(hand),
        deviceId: deviceSensitive(deviceId),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSlotConnected(hand, false)
      setSlotConnecting(hand, false, message)
      logger.warn('ble.slot.connect.fail', 'Tracker slot connect failed', {
        hand: safe(hand),
        deviceId: deviceSensitive(deviceId),
        error: safe(message),
      })
      this.tearDownBinding(hand)
      throw err
    }
  }

  /**
   * Force-evict a slot down to the radio, even when no JS binding exists.
   *
   * `disconnectSlot` only touches the radio when it holds a binding — but
   * a FAILED connect tears its binding down while the OS may still hold a
   * half-open GATT attempt for the device. This always issues the
   * facade-level disconnect (which cancels any pending connection by id),
   * so a retry pass starts from a radio-clean slate.
   */
  async evictSlot(hand: TrackerSlotHand, deviceId: string): Promise<void> {
    this.tearDownBinding(hand)
    try {
      await this.facade.disconnect(deviceId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('ble.slot.evict.fail', 'Tracker slot evict failed', {
        hand: safe(hand),
        deviceId: deviceSensitive(deviceId),
        error: safe(message),
      })
    } finally {
      clearSlot(hand)
    }
  }

  async disconnectSlot(hand: TrackerSlotHand): Promise<void> {
    const binding = this.bindings[hand]
    this.tearDownBinding(hand)
    if (!binding) {
      clearSlot(hand)
      return
    }
    try {
      await this.facade.disconnect(binding.deviceId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('ble.slot.disconnect.fail', 'Tracker slot disconnect failed', {
        hand: safe(hand),
        deviceId: deviceSensitive(binding.deviceId),
        error: safe(message),
      })
    } finally {
      clearSlot(hand)
    }
  }

  aggregate(): TrackerAggregate {
    const slots = getTrackerSlots()
    const isReady = (s: (typeof slots)['left']): boolean =>
      s?.state === 'ready' || s?.state === 'streaming'
    const leftReady = isReady(slots.left)
    const rightReady = isReady(slots.right)
    if (leftReady && rightReady) return 'bothReady'
    if (leftReady) return 'leftOnly'
    if (rightReady) return 'rightOnly'
    return 'noneReady'
  }

  private tearDownBinding(hand: TrackerSlotHand): void {
    const binding = this.bindings[hand]
    if (!binding) return
    try {
      binding.unsubscribe()
    } catch {
      // Idempotent; swallow.
    }
    this.bindings[hand] = null
    // We are about to hang up, or have stopped watching: whatever ends this
    // link now is our doing and proves nothing about the bond.
    this.cancelHoldTimer(hand)
    const diagnosis = this.bond.get(binding.deviceId)
    if (diagnosis) this.bond.set(binding.deviceId, linkAbandoned(diagnosis))
  }

  /**
   * Feed one connection event to the glove's bond diagnosis and publish the
   * verdict (H13).
   *
   * A drop the transport reports without an error counts as clean; one with
   * an error, and a connect that never came up, count for nothing. Events are
   * timed by the transport's own monotonic stamp, so nothing here reads a
   * clock.
   */
  private noteBond(hand: TrackerSlotHand, deviceId: string, status: ConnectionStatus): void {
    const before = this.bond.get(deviceId) ?? initialBondDiagnosis()
    const at = status.lastChangeMonotonicMs
    let after = before
    if (status.state === 'ready' || status.state === 'streaming') {
      if (before.readyAtMs !== null) return
      after = linkReady(before, at)
      this.cancelHoldTimer(hand)
      // If the link is still up when the window has passed, the security
      // procedure succeeded: say so, and forget earlier drops.
      this.holdTimers[hand] = setTimeout(() => {
        this.holdTimers[hand] = null
        const live = this.bond.get(deviceId)
        if (!live || live.readyAtMs === null) return
        const held = linkStillUp(live, live.readyAtMs + UNBONDED_DROP_WINDOW_MS.max + 1)
        this.bond.set(deviceId, held)
        this.publishBond(hand, deviceId, live, held, UNBONDED_DROP_WINDOW_MS.max + 1)
      }, UNBONDED_DROP_WINDOW_MS.max + 1)
    } else if (status.state === 'dormant' || status.state === 'error') {
      if (before.readyAtMs === null) return
      this.cancelHoldTimer(hand)
      after = linkDropped(before, at, status.state === 'dormant')
    } else {
      return
    }
    this.bond.set(deviceId, after)
    this.publishBond(hand, deviceId, before, after, at - (before.readyAtMs ?? at))
  }

  private publishBond(
    hand: TrackerSlotHand,
    deviceId: string,
    before: BondDiagnosis,
    after: BondDiagnosis,
    heldMs: number,
  ): void {
    setSlotBondVerdict(hand, after.verdict)
    if (after.verdict === before.verdict && after.signatureDrops === before.signatureDrops) return
    logger.info('ble.bond.verdict', 'bond diagnosis changed', {
      hand: safe(hand),
      deviceId: deviceSensitive(deviceId),
      verdict: safe(after.verdict),
      signatureDrops: safe(after.signatureDrops),
      heldMs: safe(Math.round(heldMs)),
    })
  }

  private cancelHoldTimer(hand: TrackerSlotHand): void {
    const timer = this.holdTimers[hand]
    if (timer !== null) clearTimeout(timer)
    this.holdTimers[hand] = null
  }
}

let cachedCoordinator: TrackerCoordinator | null = null

/**
 * Memoized singleton bound to the lazily-resolved BleManagerFacade. The
 * facade itself is only fetched on first call so importing this module
 * during app bootstrap (before registerBleManagerFactory) is safe.
 */
export function getTrackerCoordinator(): TrackerCoordinator {
  if (!cachedCoordinator) {
    cachedCoordinator = new TrackerCoordinator(getBleManager())
  }
  return cachedCoordinator
}

/** Test hook — drop the cached singleton so the next getTrackerCoordinator()
 * builds a fresh one against the current facade. */
export function resetTrackerCoordinatorSingleton(): void {
  cachedCoordinator = null
}
