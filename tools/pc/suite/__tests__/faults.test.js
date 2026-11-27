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
    constructor(duration) {
      this.duration = duration
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

describe('faultSource', () => {
  it('is text that runs in a page, for each fault', () => {
    for (const kind of FAULTS) {
      const page = fakePage()
      new Function('globalThis', faultSource(kind))(page.scope)
      expect(page.scope.HTMLMediaElement.prototype.play.name).toBe('play')
    }
  })
  it('refuses a fault it does not have', () => {
    expect(() => faultSource('explode')).toThrow(/a fault is one of mute, cut, late, not explode/)
  })
})
