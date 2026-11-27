/**
 * Which device a capture was written on (findings doc, N-19).
 *
 * The emulator strings are the real ones, read off the Android 15 Google APIs
 * image this PC runs (`getprop ro.product.model`, `ro.build.fingerprint`), and
 * the classic AOSP emulator's. The device strings are real shipped tablets
 * and phones — including Google's own, because "the brand is google" is true
 * of both an emulator and a Pixel and must decide nothing.
 */
import { describeDevice, isAndroidEmulator } from '../deviceKind'

const EMULATORS: Array<[string, string, string]> = [
  [
    'the Android 15 Google APIs image on this PC',
    'sdk_gphone64_x86_64',
    'google/sdk_gphone64_x86_64/emu64xa:15/AE3A.240806.043/12960925:userdebug/dev-keys',
  ],
  [
    'an arm64 Google APIs image',
    'sdk_gphone64_arm64',
    'google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.036/11228894:userdebug/dev-keys',
  ],
  [
    'an older x86 image',
    'Android SDK built for x86',
    'generic_x86/sdk_x86/generic_x86:9/PSR1.180720.075/5124027:userdebug/test-keys',
  ],
  ['the oldest AOSP image', 'sdk', 'generic/sdk/generic:4.4.2/KK/1425645:eng/test-keys'],
]

const DEVICES: Array<[string, string, string]> = [
  [
    'a Pixel Tablet',
    'Pixel Tablet',
    'google/tangorpro/tangorpro:15/AP3A.241005.015/12366759:user/release-keys',
  ],
  [
    'a Galaxy Tab A8',
    'SM-X200',
    'samsung/gta8wifixx/gta8wifi:13/TP1A.220624.014/X200XXU2CWK1:user/release-keys',
  ],
  [
    'a Lenovo tablet',
    'Lenovo TB-X606F',
    'Lenovo/LenovoTB-X606F/X606F:10/QP1A.190711.020/S300429_211101_ROW:user/release-keys',
  ],
  ['a Pixel 7', 'Pixel 7', 'google/panther/panther:15/AP3A.241105.007/12470370:user/release-keys'],
]

describe('isAndroidEmulator', () => {
  it.each(EMULATORS)('knows %s', (_name, model, fingerprint) => {
    expect(isAndroidEmulator(model, fingerprint)).toBe(true)
  })

  it.each(EMULATORS)('knows %s by either string alone', (_name, model, fingerprint) => {
    expect(isAndroidEmulator(model, undefined)).toBe(true)
    expect(isAndroidEmulator(undefined, fingerprint)).toBe(true)
  })

  it.each(DEVICES)('does not take %s for one', (_name, model, fingerprint) => {
    expect(isAndroidEmulator(model, fingerprint)).toBe(false)
  })

  it('says no when it is told nothing', () => {
    expect(isAndroidEmulator(undefined, undefined)).toBe(false)
  })
})

describe('describeDevice', () => {
  it('names an Android device and says whether it is an emulator', () => {
    const [, model, fingerprint] = EMULATORS[0]!
    expect(describeDevice('android', { Model: model, Fingerprint: fingerprint })).toEqual({
      deviceModel: 'sdk_gphone64_x86_64',
      emulator: true,
    })
    const [, tablet, tabletFingerprint] = DEVICES[1]!
    expect(describeDevice('android', { Model: tablet, Fingerprint: tabletFingerprint })).toEqual({
      deviceModel: 'SM-X200',
      emulator: false,
    })
  })

  it('never calls a browser or an iPhone an emulator — the platform already says what they are', () => {
    const emulatorish = { Model: 'sdk_gphone64_x86_64', Fingerprint: 'generic/sdk/generic' }
    expect(describeDevice('web', emulatorish)).toEqual({ deviceModel: undefined, emulator: false })
    expect(describeDevice('ios', emulatorish)).toEqual({ deviceModel: undefined, emulator: false })
  })

  it('reads missing or malformed constants as a device that said nothing', () => {
    for (const constants of [
      undefined,
      null,
      'x',
      7,
      {},
      { Model: 42, Fingerprint: null },
      { Model: '' },
    ]) {
      expect(describeDevice('android', constants)).toEqual({
        deviceModel: undefined,
        emulator: false,
      })
    }
  })
})
