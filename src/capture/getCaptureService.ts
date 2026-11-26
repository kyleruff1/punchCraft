/**
 * Process-wide BleCaptureService, wired to the app database.
 *
 * Kept separate from BleCaptureService itself so the service stays
 * constructor-injected and unit-testable, while screens get a one-call
 * accessor instead of assembling repositories by hand.
 */

import { getBleManager } from '@ble/BleManagerFacade'
import { AMBIENT_CAPTURE_LABEL, ambientCapturesToPrune } from '@capture/ambientCapture'
import { BleCaptureService } from '@capture/BleCaptureService'
import { logger, safe } from '@/diagnostics/logger'
import { openDatabase } from '@storage/database'
import { CaptureRepository } from '@storage/repositories/CaptureRepository'
import { DeviceRepository } from '@storage/repositories/DeviceRepository'
import { PunchEventRepository } from '@storage/repositories/PunchEventRepository'

let instance: BleCaptureService | null = null
let captures: CaptureRepository | null = null

/** Lazily construct the shared capture service. */
export function getCaptureService(): BleCaptureService {
  if (instance) return instance
  const db = openDatabase()
  captures = new CaptureRepository(db)
  instance = new BleCaptureService({
    captures,
    punchEvents: new PunchEventRepository(db),
    devices: new DeviceRepository(db),
  })
  return instance
}

/** Point the transport at the service: frame ids, and the sink itself. */
function installSink(service: BleCaptureService): void {
  const ble = getBleManager()
  ble.setCaptureIdProvider(() => service.currentCaptureId() ?? 'ephemeral')
  ble.setFrameSink(service)
}

/**
 * Open the ambient capture and keep every frame from here on (N-7).
 *
 * Called once at launch, before the keepalive brings a glove up, so that the
 * first frame of the first link is already covered. Idempotent.
 *
 * Before it opens the new capture it tidies the old ones: the last launch's
 * capture was ended by the app being killed, so it is closed here and what it
 * held is logged — that line is how the tablet tells us how fast a connected
 * glove produces frames when nobody is punching, which nobody has measured —
 * and anything past the retention or the frame cap is deleted.
 *
 * NEVER throws: this runs during start-up, and an app that will not start
 * because it could not keep frames is a worse failure than not keeping them.
 * It returns whether frames are being kept.
 */
export function startAmbientCapture(nowMs: number = Date.now()): boolean {
  try {
    const service = getCaptureService()
    if (service.hasAmbient()) return true
    const repo = captures
    if (repo) {
      // One listing serves both jobs: the frame counts are a scan each.
      const existing = repo.listByLabel(AMBIENT_CAPTURE_LABEL)
      const previous = existing.at(-1)
      const closed = repo.closeAbandoned(AMBIENT_CAPTURE_LABEL)
      if (previous && closed > 0) {
        logger.info('capture.ambient.previous', 'what the last connection capture held', {
          captureId: safe(previous.id),
          startedAt: safe(previous.startedAtIso),
          frames: safe(previous.frames),
          byCharacteristic: safe(JSON.stringify(repo.frameCountsByCharacteristic(previous.id))),
        })
      }
      const pruned = repo.deleteCaptures(ambientCapturesToPrune(existing, nowMs))
      if (pruned > 0) {
        logger.info('capture.ambient.pruned', 'old connection captures deleted', {
          captures: safe(pruned),
        })
      }
    }
    const captureId = service.startAmbient()
    installSink(service)
    logger.info('capture.ambient.start', 'keeping raw frames for the whole connection', {
      captureId: safe(captureId),
    })
    return true
  } catch (err) {
    logger.error('capture.ambient.failed', 'raw frames are NOT being kept', {
      error: safe(String(err)),
    })
    return false
  }
}

/** Stop keeping frames outside a labelled capture. For the Settings switch. */
export async function stopAmbientCapture(): Promise<void> {
  if (!instance || !instance.hasAmbient()) return
  await instance.stopAmbient()
  // A labelled capture that is open keeps the sink; otherwise nothing wants it.
  if (instance.currentCaptureId() === null) uninstallSink()
  logger.info('capture.ambient.stop', 'no longer keeping raw frames for the whole connection')
}

function uninstallSink(): void {
  try {
    const ble = getBleManager()
    ble.setCaptureIdProvider(() => 'ephemeral')
    ble.setFrameSink(null)
  } catch {
    /* transport already torn down */
  }
}

/**
 * Open a capture and point the BLE transport's frame-id provider at it, so
 * emitted `RawBleFrame.id`s are unique across app runs rather than restarting
 * at `ephemeral-0` and colliding with previously stored rows.
 */
export function startCapture(label?: string): BleCaptureService {
  const service = getCaptureService()
  const captureId = service.start(label != null ? { label } : {})

  // Installing the sink on the TRANSPORT means every frame is persisted
  // before it reaches any subscriber, so the Live decode screen, the protocol
  // probe and the BLE spike are all covered without opting in.
  //
  // This THROWS on failure rather than warning. A capture whose sink was never
  // installed records nothing while still reporting itself as started — the
  // caller would believe it was capturing and it would not be. Better to fail
  // the open: callers already degrade gracefully and tell the user that frames
  // are not being persisted.
  try {
    installSink(service)
  } catch (err) {
    logger.error(
      'capture.sink.install.failed',
      'transport sink not installed — capture would record nothing',
      {
        captureId: safe(captureId),
        error: safe(String(err)),
      },
    )
    void stopCapture()
    throw err
  }

  logger.info('capture.start', 'capture started', { captureId: safe(captureId) })
  return service
}

/**
 * Flush and close the labelled capture. Frames go back to the ambient
 * capture if one is open; only without one is the sink removed and the
 * transport returned to ephemeral ids, as it always was.
 */
export async function stopCapture(): Promise<void> {
  if (!instance) return
  await instance.stop()
  if (instance.currentCaptureId() === null) uninstallSink()
}

/** Reset the process-wide handle. Intended for tests. */
export function __resetCaptureServiceForTests(): void {
  instance = null
  captures = null
}
