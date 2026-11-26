/**
 * Start keeping raw frames at launch, unless it has been switched off.
 *
 * Called from the root layout BEFORE the keepalive starts: the frame sink has
 * to be on the transport before a glove can say anything, or the first frames
 * of the first link are exactly the ones that are lost.
 */
import { startAmbientCapture } from '@capture/getCaptureService'
import { logger, safe } from '@diagnostics/logger'
import { openDatabase } from '@storage/database'
import { SettingsRepository } from '@storage/repositories/SettingsRepository'

import { useCaptureSettingsStore } from './useCaptureSettingsStore'

let started = false

/** Idempotent, and never throws — it runs during start-up. */
export function startKeepingRawFramesOnce(): void {
  if (started) return
  started = true
  try {
    useCaptureSettingsStore.getState().load(new SettingsRepository(openDatabase()))
  } catch (err) {
    // Unreadable settings leave the default, which is to keep frames.
    logger.warn('settings.capture.loadFailed', 'capture settings not loaded; using defaults', {
      error: safe(String(err)),
    })
  }
  if (useCaptureSettingsStore.getState().keepRawFrames) startAmbientCapture()
  else
    logger.info('capture.ambient.off', 'raw frames are not kept outside Velocity Lab: switched off')
}

export function __resetCaptureSettingsLoadForTests(): void {
  started = false
}
