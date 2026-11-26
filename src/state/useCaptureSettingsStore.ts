/**
 * Whether raw glove frames are kept for the whole connection (N-7).
 *
 * On by default: CLAUDE.md rule 1 says every incoming frame is persisted
 * before anything decodes it, and until the ambient capture existed that
 * held only inside Velocity Lab. The switch exists because writing to SQLite
 * during a workout has never been measured against the coach's timing on the
 * tablet — it is the way back if it turns out to cost something.
 *
 * Switching it off stops the ambient capture; a Velocity Lab capture still
 * records, as it always has.
 */
import { create } from 'zustand'

import { startAmbientCapture, stopAmbientCapture } from '@capture/getCaptureService'
import { SETTINGS_KEYS } from '@storage/migrations/006_app_settings'
import type { SettingsRepository } from '@storage/repositories/SettingsRepository'

export interface CaptureSettings {
  keepRawFrames: boolean
}

export function defaultCaptureSettings(): CaptureSettings {
  return { keepRawFrames: true }
}

export interface CaptureSettingsState extends CaptureSettings {
  loaded: boolean
  load(repo: SettingsRepository): void
  setKeepRawFrames(on: boolean): void
}

let repository: SettingsRepository | null = null

export const useCaptureSettingsStore = create<CaptureSettingsState>((set) => ({
  ...defaultCaptureSettings(),
  loaded: false,

  load(repo) {
    repository = repo
    // Only a stored literal `false` turns it off. The default is the rule;
    // a row that is missing, or damaged, must not quietly suspend it.
    const { keepRawFrames } = repo.readChecked<CaptureSettings>(
      SETTINGS_KEYS.capture,
      (stored) => ({
        keepRawFrames: stored['keepRawFrames'] !== false,
      }),
    ).value
    set({ keepRawFrames, loaded: true })
  },

  setKeepRawFrames(on) {
    set({ keepRawFrames: on })
    repository?.write(SETTINGS_KEYS.capture, { keepRawFrames: on })
    if (on) startAmbientCapture()
    else void stopAmbientCapture()
  },
}))

/** Test seam: the module keeps the repository it was loaded with. */
export function __resetCaptureSettingsForTests(): void {
  repository = null
  useCaptureSettingsStore.setState({ ...defaultCaptureSettings(), loaded: false })
}
