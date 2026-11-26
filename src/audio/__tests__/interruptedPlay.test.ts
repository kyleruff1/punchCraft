/**
 * The browser's "play() was interrupted" rejection is taken off the page's
 * unhandled list — and nothing else is.
 */
import { replaceSinks, type LogRecord } from '@diagnostics/logger'

import { ignoreInterruptedPlay, isInterruptedPlay, type RejectionSource } from '../interruptedPlay'

const chromium = {
  name: 'AbortError',
  message: 'The play() request was interrupted by a call to pause(). https://goo.gl/LdLk22',
}

describe('isInterruptedPlay', () => {
  it('knows Chromium’s two wordings', () => {
    expect(isInterruptedPlay(chromium)).toBe(true)
    expect(
      isInterruptedPlay({
        name: 'AbortError',
        message: 'The play() request was interrupted by a new load request.',
      }),
    ).toBe(true)
  })

  it('leaves every other rejection alone', () => {
    // Autoplay refused: a real problem the athlete would hear as silence.
    expect(
      isInterruptedPlay({ name: 'NotAllowedError', message: 'play() failed because the user…' }),
    ).toBe(false)
    // An abort that is not a play() — a cancelled fetch, say.
    expect(isInterruptedPlay({ name: 'AbortError', message: 'The user aborted a request.' })).toBe(
      false,
    )
    expect(isInterruptedPlay(new TypeError('x is not a function'))).toBe(false)
    expect(isInterruptedPlay('AbortError')).toBe(false)
    expect(isInterruptedPlay(null)).toBe(false)
    expect(isInterruptedPlay(undefined)).toBe(false)
  })
})

describe('ignoreInterruptedPlay', () => {
  let fire: (reason: unknown) => { prevented: boolean }
  let records: LogRecord[]

  beforeEach(() => {
    records = []
    replaceSinks([{ write: (r) => records.push(r) }])
    const source: RejectionSource = {
      addEventListener: (_type, listener) => {
        fire = (reason) => {
          const event = { reason, prevented: false, preventDefault: () => undefined }
          event.preventDefault = () => {
            event.prevented = true
          }
          listener(event)
          return event
        }
      },
    }
    ignoreInterruptedPlay(source)
  })
  afterEach(() => replaceSinks([]))

  it('handles the interrupted play, and counts it', () => {
    expect(fire(chromium).prevented).toBe(true)
    expect(fire(chromium).prevented).toBe(true)
    const counted = records.filter((r) => r.code === 'audio.web.playInterrupted')
    expect(counted.map((r) => r.fields.count?.value)).toEqual([1, 2])
  })

  it('lets anything else through to the console, unlogged', () => {
    expect(fire(new Error('the database could not be saved')).prevented).toBe(false)
    expect(records).toHaveLength(0)
  })
})
