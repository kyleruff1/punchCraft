/**
 * The sound tap. Two halves run where no test can reach — one in the page,
 * one in the audio thread — so both are written to be handed their world,
 * and here they are handed a fake one.
 */
import vm from 'node:vm'

import {
  ENVELOPE_WORKLET_SOURCE,
  envelopeStep,
  installSoundTap,
  newEnvelope,
  SOUND_BINDING,
  SOUND_HOLD_SEC,
  SOUND_THRESHOLD,
  soundTapSource,
} from '../soundTap.mjs'

const BLOCK = 128 / 48_000
const loud = [0, 0.2, -0.5, 0.1]
const quiet = [0, 0.001, -0.002]
/** Feed blocks from time zero; return the events with the block each came from. */
function feed(state, blocks) {
  const events = []
  blocks.forEach((samples, i) => {
    const event = envelopeStep(state, samples, i * BLOCK, BLOCK)
    if (event) events.push({ block: i, ...event })
  })
  return events
}
const blocksFor = (seconds) => Math.ceil(seconds / BLOCK)
// One block more than the hold divides into: thirty blocks of 128 samples sum
// to a hair under 80 ms in floating point, and the hold has to be *reached*.
const PAST_THE_HOLD = blocksFor(SOUND_HOLD_SEC) + 1

describe('envelopeStep', () => {
  it('says nothing about silence', () => {
    expect(feed(newEnvelope(), [quiet, quiet, [], quiet])).toEqual([])
  })

  it('starts a stretch at the start of the first loud block', () => {
    expect(feed(newEnvelope(), [quiet, quiet, loud, loud])).toEqual([
      { block: 2, type: 'sound-start', timeSec: 2 * BLOCK },
    ])
  })

  it('ends it where the last loud block ended — not where the hold ran out', () => {
    const events = feed(newEnvelope(), [loud, loud, loud, ...Array(PAST_THE_HOLD).fill(quiet)])
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'sound-end', peak: 0.5 })
    expect(events[1].timeSec).toBeCloseTo(3 * BLOCK, 9)
    // …and it was only certain once the hold had passed.
    expect((events[1].block - 2) * BLOCK).toBeGreaterThanOrEqual(SOUND_HOLD_SEC)
  })

  it('rides over a gap shorter than the hold, as speech has between words', () => {
    const gap = Array(blocksFor(SOUND_HOLD_SEC) - 2).fill(quiet)
    expect(feed(newEnvelope(), [loud, ...gap, loud, loud]).map((e) => e.type)).toEqual([
      'sound-start',
    ])
  })

  it('reports a second stretch after the first has ended', () => {
    const gap = Array(PAST_THE_HOLD).fill(quiet)
    expect(feed(newEnvelope(), [loud, ...gap, loud, ...gap]).map((e) => e.type)).toEqual([
      'sound-start',
      'sound-end',
      'sound-start',
      'sound-end',
    ])
  })

  it('takes the threshold as the line: at it is silence, over it is sound', () => {
    expect(feed(newEnvelope(), [[SOUND_THRESHOLD]])).toEqual([])
    expect(feed(newEnvelope(), [[-SOUND_THRESHOLD * 1.01]])).toHaveLength(1)
  })
})

describe('the audio thread’s half, as the text it is loaded from', () => {
  function load() {
    const world = { currentTime: 0, sampleRate: 48_000, registered: null }
    world.AudioWorkletProcessor = class {
      constructor() {
        this.port = { sent: [], postMessage: (m) => this.port.sent.push(m) }
      }
    }
    world.registerProcessor = (name, ctor) => (world.registered = { name, ctor })
    vm.runInNewContext(ENVELOPE_WORKLET_SOURCE, world)
    return world
  }

  it('registers a follower that reports a stretch in the context’s own time', () => {
    const world = load()
    expect(world.registered.name).toBe('pc-envelope')
    const follower = new world.registered.ctor()
    const blocks = [quiet, loud, loud, ...Array(PAST_THE_HOLD).fill(quiet)]
    blocks.forEach((samples, i) => {
      world.currentTime = 10 + i * BLOCK
      expect(follower.process([[Float32Array.from(samples)]])).toBe(true)
    })
    expect(follower.port.sent.map((m) => m.type)).toEqual(['sound-start', 'sound-end'])
    expect(follower.port.sent[0].timeSec).toBeCloseTo(10 + BLOCK, 9)
    expect(follower.port.sent[1].timeSec).toBeCloseTo(10 + 3 * BLOCK, 9)
  })

  it('treats an element with nothing connected as silence', () => {
    const follower = new (load().registered.ctor)()
    expect(follower.process([[]])).toBe(true)
    expect(follower.process([])).toBe(true)
    expect(follower.port.sent).toEqual([])
  })
})

/** A page with the few parts of the Web Audio and media APIs the tap touches. */
function fakePage({ sourceThrows = false } = {}) {
  const sent = []
  const followers = []
  let now = 1000
  class FakeElement {
    constructor(src = '') {
      this.src = src
      this.currentSrc = src
      this.currentTime = 0
      this.volume = 1
      this.muted = false
      this.duration = NaN
      this.listeners = {}
      this.played = 0
    }
    addEventListener(type, fn) {
      ;(this.listeners[type] ??= []).push(fn)
    }
    fire(type) {
      for (const fn of this.listeners[type] ?? []) fn()
    }
    play() {
      this.played += 1
      return 'native'
    }
  }
  const context = {
    state: 'running',
    sampleRate: 48_000,
    baseLatency: 0.01,
    outputLatency: 0,
    currentTime: 5,
    destination: { name: 'destination' },
    // The moment leaving for the output now is context second 5, at 2000 on the page's clock.
    getOutputTimestamp: () => ({ contextTime: 5, performanceTime: 2000 }),
    createMediaElementSource: (element) => {
      if (sourceThrows) throw new Error('already connected')
      return { element, connect: () => {} }
    },
    createGain: () => ({ gain: { value: 1 }, connect: () => {} }),
    audioWorklet: { addModule: () => Promise.resolve() },
    resume: () => Promise.resolve(),
  }
  const scope = {
    performance: { now: () => now },
    AudioContext: function () {
      return context
    },
    AudioWorkletNode: function (_context, name) {
      this.name = name
      this.port = {}
      this.connect = () => {}
      followers.push(this)
    },
    Audio: FakeElement,
    HTMLMediaElement: FakeElement,
    URL: { createObjectURL: () => 'blob:worklet' },
    Blob: function () {},
    [SOUND_BINDING]: (payload) => sent.push(JSON.parse(payload)),
  }
  // The tap readies itself over a few promise turns; let them all run.
  const settle = async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
  }
  return { scope, sent, followers, FakeElement, settle, at: (ms) => (now = ms) }
}

describe('installSoundTap', () => {
  it('reports each play with what the element was doing when it was asked', async () => {
    const page = fakePage()
    installSoundTap(page.scope, SOUND_BINDING, 'worklet', false)
    await page.settle()
    const element = new page.scope.Audio('http://127.0.0.1/assets/call_1-2.abc.wav')
    element.volume = 0.8
    page.at(1500)
    expect(element.play()).toBe('native')
    expect(element.played).toBe(1)
    expect(page.sent.find((e) => e.type === 'play')).toEqual({
      id: 1,
      type: 'play',
      atMs: 1500,
      src: 'call_1-2.abc.wav',
      positionMs: 0,
      volume: 0.8,
      durationMs: null,
    })
  })

  it('counts plays, not elements: a reused element reports again under the same id', async () => {
    const page = fakePage()
    installSoundTap(page.scope, SOUND_BINDING, 'worklet', false)
    await page.settle()
    const element = new page.scope.Audio('a.wav')
    element.play()
    element.play()
    new page.scope.Audio('b.wav').play()
    expect(page.sent.filter((e) => e.type === 'play').map((e) => e.id)).toEqual([1, 1, 2])
  })

  it('still makes real elements: what the page builds is what it asked for', () => {
    const page = fakePage()
    installSoundTap(page.scope, SOUND_BINDING, 'worklet', false)
    const element = new page.scope.Audio('a.wav')
    expect(element).toBeInstanceOf(page.FakeElement)
    expect(element.src).toBe('a.wav')
  })

  it('puts a stretch of sound on the page’s clock', async () => {
    const page = fakePage()
    installSoundTap(page.scope, SOUND_BINDING, 'worklet', false)
    await page.settle()
    new page.scope.Audio('a.wav')
    // Context second 5.25 is a quarter of a second after the moment that left at 2000.
    page.followers[0].port.onmessage({ data: { type: 'sound-start', timeSec: 5.25 } })
    page.followers[0].port.onmessage({ data: { type: 'sound-end', timeSec: 6, peak: 0.4 } })
    expect(page.sent.filter((e) => e.type.startsWith('sound'))).toEqual([
      { id: 1, type: 'sound-start', atMs: 2250 },
      { id: 1, type: 'sound-end', atMs: 3000, peak: 0.4 },
    ])
  })

  it('says a muted element plays at volume 0, and reports what the element reports', async () => {
    const page = fakePage()
    installSoundTap(page.scope, SOUND_BINDING, 'worklet', false)
    await page.settle()
    const element = new page.scope.Audio('a.wav')
    element.muted = true
    element.duration = 0.927
    element.fire('playing')
    expect(page.sent.find((e) => e.type === 'playing')).toMatchObject({
      id: 1,
      volume: 0,
      durationMs: 927,
    })
  })

  it('says so when it is ready, and when an element could not be tapped', async () => {
    const page = fakePage({ sourceThrows: true })
    installSoundTap(page.scope, SOUND_BINDING, 'worklet', false)
    await page.settle()
    const element = new page.scope.Audio('a.wav')
    expect(page.sent.find((e) => e.type === 'tap-ready')).toMatchObject({
      state: 'running',
      sampleRate: 48_000,
    })
    expect(page.sent.find((e) => e.type === 'tap-failed')).toMatchObject({
      id: 1,
      error: 'Error: already connected',
    })
    // The page is not the tap's to break.
    expect(element.play()).toBe('native')
  })

  it('wires an element made before the audio thread’s half had loaded, once it has', async () => {
    const page = fakePage()
    installSoundTap(page.scope, SOUND_BINDING, 'worklet', false)
    new page.scope.Audio('early.wav')
    expect(page.followers).toHaveLength(0)
    await page.settle()
    expect(page.followers).toHaveLength(1)
  })

  it('leaves a page alone where there is no driver or no Web Audio', () => {
    const noDriver = fakePage()
    delete noDriver.scope[SOUND_BINDING]
    installSoundTap(noDriver.scope, SOUND_BINDING, 'worklet', false)
    expect(noDriver.scope.Audio).toBe(noDriver.FakeElement)
    const noAudio = fakePage()
    delete noAudio.scope.AudioContext
    installSoundTap(noAudio.scope, SOUND_BINDING, 'worklet', false)
    expect(noAudio.scope.Audio).toBe(noAudio.FakeElement)
  })

  it('works as the text that is run in the page', async () => {
    const page = fakePage()
    new Function('globalThis', soundTapSource())(page.scope)
    await page.settle()
    new page.scope.Audio('a.wav').play()
    expect(page.sent.map((e) => e.type)).toEqual(['tap-ready', 'play'])
  })
})
