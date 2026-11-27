/**
 * Which device wrote a capture — the question the timing analyzer asks before
 * it will say anything, because its figures describe the tablet's audio path
 * and nothing else's.
 */

import { capturePlatform, LOG_PREFIX, WEB_CAPTURE_TAG } from '../logcat.mjs'

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

  it('writes a tag the parser accepts', () => {
    // The tag is free text to every analyzer here; this pins that the one the
    // PC writes is still a line they can read.
    expect(LOG_PREFIX.test(line(WEB_CAPTURE_TAG, "'[INFO] x', 'm'"))).toBe(true)
  })
})
