/**
 * Found, not fixed (findings doc, §3j): a call can be cut short by a timer
 * left over from before a pause.
 *
 * THIS PINS TODAY'S BEHAVIOUR. It does not say the behaviour is wanted.
 *
 * Every per-bar call parks its player back at the start once the clip has
 * finished, from a timer set when the call was sent. The timer carries the
 * call's generation — a per-clip counter — and does nothing if the clip has
 * been sent again since.
 *
 * A pause clears those counters (`cancel(safety)`), so the next send of the
 * same clip starts again at 1 — the number the timer from before the pause is
 * still holding. If the athlete pauses and resumes inside the couple of
 * seconds that timer has left, and the same call comes round again (the same
 * bar's call does, every bar), the old timer passes its own guard and PAUSES
 * THE PLAYER THAT IS SOUNDING THE NEW CALL.
 *
 * `release()` deliberately does not clear the counters, for exactly this
 * reason, and says so in a comment. `cancel(safety)` does.
 *
 * Narrow: pause and resume within about a clip's length plus 200 ms of a call,
 * with the same call due again. One call is cut; the next is unaffected.
 */
jest.mock('expo-audio', () => ({
  createAudioPlayer: () => {
    throw new Error('expo-audio is not available in tests; inject createPlayer')
  },
  setAudioModeAsync: async () => undefined,
}))
jest.mock('expo-speech', () => ({ speak: () => {}, stop: () => {} }))

import { CLICK_SCRIPT_PREARM_PAD_MS, VoiceOutputExpo } from '../VoiceOutputExpo'
import { AUDIO_PRIORITY } from '@domain/coach/VoiceOutputPort'

function rig() {
  let clock = 0
  let nextId = 1
  const timers: { at: number; fn: () => void; id: number }[] = []
  /** When the click-script player was played and paused, on the rig's clock. */
  const plays: number[] = []
  const pauses: number[] = []
  const output = new VoiceOutputExpo({
    clock: () => clock,
    schedule: (fn, delayMs) => {
      const id = nextId++
      timers.push({ at: clock + delayMs, fn, id })
      return id
    },
    cancelScheduled: (handle) => {
      const i = timers.findIndex((t) => t.id === handle)
      if (i >= 0) timers.splice(i, 1)
    },
    createClickScriptPlayer: (() =>
      ({
        volume: 1,
        seekTo: () => Promise.resolve(),
        play: () => plays.push(clock),
        pause: () => pauses.push(clock),
        remove: () => {},
      }) as never) as never,
    setAudioMode: (async () => {}) as never,
  })
  return {
    output,
    plays,
    pauses,
    /** Move the clock on, firing each timer as it falls due, and let promises settle. */
    async advance(ms: number): Promise<void> {
      const until = clock + ms
      for (;;) {
        const due = [...timers].sort((a, b) => a.at - b.at)[0]
        if (!due || due.at > until) break
        clock = Math.max(clock, due.at)
        timers.splice(timers.indexOf(due), 1)
        due.fn()
      }
      clock = until
      for (let i = 0; i < 4; i++) await Promise.resolve()
    },
  }
}

const CALL = { text: 'One, two!', module: 77, durationMs: 700 }

describe('found, not fixed: a timer from before a pause', () => {
  it('pauses the same call when it is sent again after the resume', async () => {
    const h = rig()
    h.output.playClickScript(CALL) // sent at 0; its timer is due at 700 + the pad
    await h.advance(300)
    h.output.cancel(AUDIO_PRIORITY.safety) // the pause, 300 ms into the call
    expect(h.pauses).toEqual([300])

    await h.advance(200)
    h.output.playClickScript(CALL) // the resume: the same bar's call comes round
    await h.advance(0) // its rewind settles, and it plays
    expect(h.plays).toEqual([0, 500]) // sounding from 500, for 700 ms

    // The first call's timer falls due while the second is still sounding…
    const staleAt = CALL.durationMs + CLICK_SCRIPT_PREARM_PAD_MS
    expect(staleAt).toBeLessThan(500 + CALL.durationMs)
    await h.advance(staleAt - 500)
    // …and pauses it, some 300 ms before its end.
    expect(h.pauses).toEqual([300, staleAt])
  })

  it('leaves it alone when there was no pause: the counter has moved on', async () => {
    const h = rig()
    h.output.playClickScript(CALL)
    await h.advance(500)
    h.output.playClickScript(CALL) // sent again with no pause between
    await h.advance(CALL.durationMs + CLICK_SCRIPT_PREARM_PAD_MS - 500)
    // The first timer saw a newer generation and did nothing.
    expect(h.pauses).toEqual([])
  })
})
