/**
 * Which device wrote a capture — the question the timing analyzer asks before
 * it will say anything, because its figures describe the tablet's audio path
 * and nothing else's.
 */

import { capturePlatform, EMULATOR_PLATFORM, LOG_PREFIX, WEB_CAPTURE_TAG } from '../logcat.mjs'

const line = (tag, body) => `11-26 10:00:00.000 I/${tag}( 4242): ${body}`
const qaRun = (tag, fields) => line(tag, `'[INFO] workout.qa.run', 'QA run staged from deep link', { ${fields} }`)

describe('capturePlatform', () => {
  it('takes the QA run record at its word', () => {
    expect(capturePlatform(qaRun('ReactNativeJS', "workout: 'body-work', platform: 'android'"))).toBe('android')
    expect(capturePlatform(qaRun('ReactNativeJS', "workout: 'body-work', platform: 'web'"))).toBe('web')
  })

  it('reads the field across the lines React Native wraps a record over', () => {
    const wrapped = [
      line('ReactNativeJS', "'[INFO] workout.qa.run', 'QA run staged from deep link', { workout: 'body-work',"),
      line('ReactNativeJS', "  platform: 'web',"),
      line('ReactNativeJS', "  platformVersion: '0.0.0' }"),
    ].join('\n')
    expect(capturePlatform(wrapped)).toBe('web')
  })

  it('is not fooled by platformVersion, which every capture has carried', () => {
    expect(capturePlatform(qaRun('ReactNativeJS', "workout: 'body-work', platformVersion: '15'"))).toBe('android')
  })

  it('calls a capture that says nothing the tablet’s, as every stored one is', () => {
    expect(capturePlatform(qaRun('ReactNativeJS', "workout: 'body-work', gitSha: 'b8e72bc5'"))).toBe('android')
    expect(capturePlatform('')).toBe('android')
  })

  it('knows a PC capture by its tag when no QA run record is in it', () => {
    const text = line(WEB_CAPTURE_TAG, "'[INFO] workout.round.boundary', 'session phase boundary', { transition: 'work-entered' }")
    expect(capturePlatform(text)).toBe('web')
  })

  it('lets the record outrank the tag, and the last record outrank an earlier one', () => {
    expect(capturePlatform(qaRun(WEB_CAPTURE_TAG, "workout: 'body-work', platform: 'android'"))).toBe('android')
    const twice = [qaRun('ReactNativeJS', "nonce: 'a', platform: 'android'"), qaRun('ReactNativeJS', "nonce: 'b', platform: 'web'")].join('\n')
    expect(capturePlatform(twice)).toBe('web')
  })

  it('calls an Android emulator what it is, on the record’s word', () => {
    expect(EMULATOR_PLATFORM).toBe('android-emulator')
    expect(capturePlatform(qaRun('ReactNativeJS', "workout: 'body-work', platform: 'android', emulator: true, deviceModel: 'sdk_gphone64_x86_64'"))).toBe('android-emulator')
    // Even from a record that names no platform: Android is what silence means.
    expect(capturePlatform(qaRun('ReactNativeJS', "workout: 'body-work', emulator: true"))).toBe('android-emulator')
  })

  it('reads that field across wrapped lines too', () => {
    const wrapped = [
      line('ReactNativeJS', "'[INFO] workout.qa.run', 'QA run staged from deep link', { workout: 'body-work',"),
      line('ReactNativeJS', "  platform: 'android',"),
      line('ReactNativeJS', "  platformVersion: '35',"),
      line('ReactNativeJS', '  emulator: true,'),
      line('ReactNativeJS', "  deviceModel: 'sdk_gphone64_x86_64' }"),
    ].join('\n')
    expect(capturePlatform(wrapped)).toBe('android-emulator')
  })

  it('leaves a real device, and a build that never said, as the tablet', () => {
    expect(capturePlatform(qaRun('ReactNativeJS', "workout: 'body-work', platform: 'android', emulator: false, deviceModel: 'SM-X200'"))).toBe('android')
    expect(capturePlatform(qaRun('ReactNativeJS', "workout: 'body-work', platform: 'android'"))).toBe('android')
  })

  it('never calls a browser an emulator', () => {
    expect(capturePlatform(qaRun('ReactNativeJS', "workout: 'body-work', platform: 'web', emulator: false, deviceModel: null"))).toBe('web')
    expect(capturePlatform(qaRun('ReactNativeJS', "workout: 'body-work', platform: 'web', emulator: true"))).toBe('web')
  })

  it('goes by the last drive in the capture', () => {
    const real = "nonce: 'a', platform: 'android', emulator: false"
    const emu = "nonce: 'b', platform: 'android', emulator: true"
    expect(capturePlatform([qaRun('ReactNativeJS', real), qaRun('ReactNativeJS', emu)].join('\n'))).toBe('android-emulator')
    expect(capturePlatform([qaRun('ReactNativeJS', emu), qaRun('ReactNativeJS', real)].join('\n'))).toBe('android')
  })

  it('writes a tag the parser accepts', () => {
    // The tag is free text to every analyzer here; this pins that the one the
    // PC writes is still a line they can read.
    expect(LOG_PREFIX.test(line(WEB_CAPTURE_TAG, "'[INFO] x', 'm'"))).toBe(true)
  })
})
