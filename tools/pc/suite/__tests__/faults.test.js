/**
 * The faults that break the app on purpose. They exist to prove the sound
 * gate fires, so what matters here is that each does the one thing it says
 * and leaves every other play alone.
 */
import {
  CALL_MAX_SEC,
  CUT_AFTER_MS,
  EVERY,
  faultSource,
  FAULTS,
  installFault,
  LATE_BY_MS,
} from '../faults.mjs'

const HOW = {
  callMaxSec: CALL_MAX_SEC,
  cutAfterMs: CUT_AFTER_MS,
  lateByMs: LATE_BY_MS,
  every: EVERY,
}

function fakePage() {
  const timers = []
  class FakeElement {
    constructor(duration, src = 'blob:http://127.0.0.1/3f2a9c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f') {
      this.duration = duration
      this.currentSrc = src
      this.muted = false
      this.played = 0
      this.paused = 0
    }
    play() {
      this.played += 1
      return Promise.resolve('native')
    }
    pause() {
      this.paused += 1
    }
  }
  const scope = {
    HTMLMediaElement: FakeElement,
    WeakSet,
    Promise,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  }
  return { scope, timers, call: () => new FakeElement(0.927), FakeElement }
}
/** Play `element` until the fault's turn comes up, and return on that play. */
const untilFaulted = (element) => {
  let result
  for (let i = 0; i < EVERY; i += 1) result = element.play()
  return result
}

describe('installFault', () => {
  it('touches one call in four and nothing else', () => {
    const page = fakePage()
    installFault(page.scope, 'mute', HOW)
    const call = page.call()
    const mutedOn = []
    for (let i = 1; i <= 8; i += 1) {
      call.play()
      if (call.muted) mutedOn.push(i)
    }
    expect(mutedOn).toEqual([EVERY, EVERY * 2])
    expect(call.played).toBe(8)
  })

  it('leaves a lead-in alone, and a clip whose length is not known yet', () => {
    const page = fakePage()
    installFault(page.scope, 'mute', HOW)
    const leadIn = new page.FakeElement(7.9)
    const unloaded = new page.FakeElement(NaN)
    for (let i = 0; i < 12; i += 1) {
      leadIn.play()
      unloaded.play()
    }
    expect(leadIn.muted).toBe(false)
    expect(unloaded.muted).toBe(false)
    expect(leadIn.played).toBe(12)
  })

  it('mute: the app still plays the clip, and nothing sounds', async () => {
    const page = fakePage()
    installFault(page.scope, 'mute', HOW)
    const call = page.call()
    await expect(untilFaulted(call)).resolves.toBe('native')
    expect(call.muted).toBe(true)
  })

  it('cut: the clip starts and is stopped part-way', () => {
    const page = fakePage()
    installFault(page.scope, 'cut', HOW)
    const call = page.call()
    untilFaulted(call)
    expect(call.played).toBe(EVERY)
    expect(page.timers).toEqual([{ fn: expect.any(Function), ms: CUT_AFTER_MS }])
    page.timers[0].fn()
    expect(call.paused).toBe(1)
  })

  it('late: the clip is held back, and the app’s next pause of it is dropped once', async () => {
    const page = fakePage()
    installFault(page.scope, 'late', HOW)
    const call = page.call()
    const asked = untilFaulted(call)
    // Asked for, not yet started.
    expect(call.played).toBe(EVERY - 1)
    expect(page.timers).toEqual([{ fn: expect.any(Function), ms: LATE_BY_MS }])
    // The app parks the player when the clip should be over: dropped…
    call.pause()
    expect(call.paused).toBe(0)
    // …but only once.
    call.pause()
    expect(call.paused).toBe(1)
    page.timers[0].fn()
    await expect(asked).resolves.toBe('native')
    expect(call.played).toBe(EVERY)
  })

  it('does not get in the way of a pause it did not cause', () => {
    const page = fakePage()
    installFault(page.scope, 'late', HOW)
    const call = page.call()
    call.pause()
    expect(call.paused).toBe(1)
  })
})

describe('which clips a fault touches', () => {
  const BELL = 'http://127.0.0.1/assets/audio/bell.0123456789abcdef0123456789abcdef.wav'
  const SILENCE = 'http://127.0.0.1/assets/audio/silence-350.0123456789abcdef0123456789abcdef.wav'

  it('the call faults leave a bell and a silence file alone, short as they are', () => {
    const page = fakePage()
    installFault(page.scope, 'mute', HOW)
    const bell = new page.FakeElement(1.18, BELL)
    const silence = new page.FakeElement(0.35, SILENCE)
    for (let i = 0; i < 12; i += 1) {
      bell.play()
      silence.play()
    }
    expect(bell.muted).toBe(false)
    expect(silence.muted).toBe(false)
    expect(bell.played).toBe(12)
  })

  it('mute-bell: every bell is rung in silence, and nothing else is touched', () => {
    const page = fakePage()
    installFault(page.scope, 'mute-bell', HOW)
    const bell = new page.FakeElement(1.18, BELL)
    const call = page.call()
    const bellows = new page.FakeElement(1.18, 'http://127.0.0.1/assets/audio/bellows.abc.wav')
    bell.play()
    for (let i = 0; i < 8; i += 1) call.play()
    bellows.play()
    expect(bell.muted).toBe(true)
    expect(bell.played).toBe(1)
    expect(call.muted).toBe(false)
    expect(bellows.muted).toBe(false)
  })
})

describe('cut-countdown', () => {
  it('stops each countdown clip part-way, and nothing else', () => {
    const page = fakePage()
    installFault(page.scope, 'cut-countdown', HOW)
    const opener = new page.FakeElement(2.6, 'http://127.0.0.1/assets/audio/warn-opener-15.abc.wav')
    const call = page.call()
    const bell = new page.FakeElement(1.18, 'http://127.0.0.1/assets/audio/bell.abc.wav')
    opener.play()
    for (let i = 0; i < 8; i += 1) call.play()
    bell.play()
    expect(page.timers).toEqual([{ fn: expect.any(Function), ms: CUT_AFTER_MS }])
    page.timers[0].fn()
    expect(opener.paused).toBe(1)
    expect(call.paused + bell.paused).toBe(0)
  })
})

describe('faultSource', () => {
  it('is text that runs in a page, for each fault', () => {
    for (const kind of FAULTS) {
      const page = fakePage()
      new Function('globalThis', faultSource(kind))(page.scope)
      expect(page.scope.HTMLMediaElement.prototype.play.name).toBe('play')
    }
  })
  it('refuses a fault it does not have', () => {
    expect(() => faultSource('explode')).toThrow(
      /a fault is one of mute, cut, late, mute-bell, cut-countdown, not explode/,
    )
  })
})
