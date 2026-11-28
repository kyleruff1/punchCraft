/**
 * What the device a build is running on says about itself — and whether it
 * is an emulator.
 *
 * Asked for one reason. An Android emulator on the PC writes a real Android
 * capture, and the tablet's timing analyzer
 * (`tools/analysis/observed-timing.mjs`) must not take it for the tablet's:
 * every figure in it would be the PC's, and every constant proposed from it a
 * tablet constant. On 2026-11-27 it did exactly that — an emulator's capture
 * was accepted and `CALL_DISPATCH_LAG_MS` proposed at 28 against 71 (findings
 * doc, N-19). So the QA run record now says what wrote it, and the analyzer
 * refuses an emulator as it refuses the PC version.
 *
 * No native module is involved. React Native already reads `Build.MODEL` and
 * `Build.FINGERPRINT` into `Platform.constants` on Android; this only reads
 * them.
 *
 * Pure: it is handed the values and imports nothing.
 */

export interface DeviceDescription {
  /** `Build.MODEL` on Android; undefined elsewhere. */
  deviceModel: string | undefined
  /** True only for an Android emulator. A browser is not one — it says `web`. */
  emulator: boolean
}

/**
 * `Build.FINGERPRINT` is `brand/product/device:release/id/incremental:type/tags`.
 * Every emulator image's PRODUCT begins `sdk` (`sdk_gphone64_x86_64`,
 * `sdk_phone_x86`, plain `sdk`) and its DEVICE is `emu64…` or `generic…`; the
 * oldest images begin the whole string with `generic`. No shipped device does
 * any of the three.
 */
const EMULATOR_FINGERPRINT: readonly RegExp[] = [
  /^generic/i,
  /\/sdk[_/]/i,
  /\/emu64/i,
  /\/generic/i,
]

/** `Build.MODEL`: `sdk_gphone64_x86_64`, plain `sdk`, `Android SDK built for x86`, `Emulator`. */
const EMULATOR_MODEL: readonly RegExp[] = [
  /^sdk(_|$)/i,
  /google_sdk/i,
  /android sdk built for/i,
  /emulator/i,
]

/** Whether those two strings are an Android emulator's. Either one is enough. */
export function isAndroidEmulator(
  model: string | undefined,
  fingerprint: string | undefined,
): boolean {
  return (
    (fingerprint !== undefined && EMULATOR_FINGERPRINT.some((mark) => mark.test(fingerprint))) ||
    (model !== undefined && EMULATOR_MODEL.some((mark) => mark.test(model)))
  )
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/**
 * Describe the device from `Platform.OS` and `Platform.constants`.
 *
 * `constants` is `unknown` on purpose: its shape differs by platform, a
 * browser has none of these fields, and a test environment may have none at
 * all. Anything missing reads as "not an emulator" — which is also what every
 * capture taken before this existed says, and all of those are the tablet's.
 */
export function describeDevice(os: string, constants: unknown): DeviceDescription {
  if (os !== 'android' || typeof constants !== 'object' || constants === null) {
    return { deviceModel: undefined, emulator: false }
  }
  const fields = constants as Record<string, unknown>
  const deviceModel = text(fields.Model)
  return { deviceModel, emulator: isAndroidEmulator(deviceModel, text(fields.Fingerprint)) }
}
