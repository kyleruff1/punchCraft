// Hearing what the page plays, with no microphone.
//
// The tablet's timing is judged from a playback observer and a measured
// constant, because the only other way to know when sound started there is a
// microphone. A browser can do better: every clip is an `<audio>` element,
// and an element's sound can be routed through a point in the page that
// looks at the samples. So this script, run in the page before the app's
// own, sends each element's sound through an envelope follower and reports
// when it rises above silence and when it falls back.
//
// What that measures is the sound entering the browser's mixer. The speaker
// is a further, constant delay — the same question the tablet has open as
// PLAYHEAD_TO_SPEAKER_MS — and the routing itself replaces the element's
// usual output path. So the figures to trust are sound against the schedule
// and sound against sound; an absolute start latency describes this graph.
//
// The follower's rule is the mic tools' rule, simplified: sound is a block
// of samples whose peak is over a threshold, and it has stopped once the
// blocks stay under it for a hold time. Speech has gaps longer than the
// hold, so one clip may report several stretches; they are joined outside
// the page, where it costs the page nothing.

/** The name of the function the driver plants in the page to receive sound events. */
export const SOUND_BINDING = '__pcSound'

/** A block is sound when its peak is over this: −48 dB of full scale. */
export const SOUND_THRESHOLD = 0.004
/** Quiet for this long ends a stretch of sound. */
export const SOUND_HOLD_SEC = 0.08

/**
 * @typedef {object} EnvelopeState
 * @property {number} threshold
 * @property {number} holdSec
 * @property {boolean} sounding
 * @property {number} quietSec how long it has been quiet since the last loud block
 * @property {number} peak the loudest sample of the current stretch
 * @property {number} lastLoudEndSec when the last loud block ended
 */

/** @returns {EnvelopeState} */
export const newEnvelope = (threshold = SOUND_THRESHOLD, holdSec = SOUND_HOLD_SEC) => ({
  threshold,
  holdSec,
  sounding: false,
  quietSec: 0,
  peak: 0,
  lastLoudEndSec: 0,
})

/**
 * Fold one block of samples into the envelope. Returns the event the block
 * caused, or null.
 *
 * A stretch starts at the start of its first loud block and ends at the end
 * of its last one — not when the hold ran out, which is only when it became
 * certain.
 *
 * Self-contained: it is turned into text and run in the audio thread.
 *
 * @param {EnvelopeState} state
 * @param {ArrayLike<number>} samples
 * @param {number} timeSec when this block starts
 * @param {number} blockSec how long it lasts
 * @returns {{ type: 'sound-start', timeSec: number } | { type: 'sound-end', timeSec: number, peak: number } | null}
 */
export function envelopeStep(state, samples, timeSec, blockSec) {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const level = samples[i] < 0 ? -samples[i] : samples[i]
    if (level > peak) peak = level
  }
  const loud = peak > state.threshold
  if (!state.sounding) {
    if (!loud) return null
    state.sounding = true
    state.quietSec = 0
    state.peak = peak
    state.lastLoudEndSec = timeSec + blockSec
    return { type: 'sound-start', timeSec }
  }
  if (loud) {
    if (peak > state.peak) state.peak = peak
    state.quietSec = 0
    state.lastLoudEndSec = timeSec + blockSec
    return null
  }
  state.quietSec += blockSec
  if (state.quietSec < state.holdSec) return null
  state.sounding = false
  return { type: 'sound-end', timeSec: state.lastLoudEndSec, peak: state.peak }
}

/** The audio thread's half: one follower per element, as text for `addModule`. */
export const ENVELOPE_WORKLET_SOURCE = `
const step = ${envelopeStep.toString()}
const SILENCE = new Float32Array(0)
class PcEnvelope extends AudioWorkletProcessor {
  constructor() {
    super()
    this.state = ${JSON.stringify(newEnvelope())}
  }
  process(inputs) {
    const channel = (inputs[0] && inputs[0][0]) || SILENCE
    const event = step(this.state, channel, currentTime, 128 / sampleRate)
    if (event) this.port.postMessage(event)
    return true
  }
}
registerProcessor('pc-envelope', PcEnvelope)
`

/**
 * The page's half: route every `<audio>` element through a follower, and
 * report each play and each stretch of sound to `scope[binding]`.
 *
 * An event is `{ id, type, atMs, … }`: `id` names the element, `atMs` is on
 * the page's `performance.now()` clock — the app's own monotonic clock, so
 * an event can be set beside a log record directly. Types: `play` (the call,
 * with the element's volume and position), `playing`, `pause`, `ended`,
 * `emptied`, `volumechange`, `sound-start`, `sound-end`; and from the tap
 * itself `tap-ready`, `tap-failed`, `recording`.
 *
 * Self-contained: it is turned into text and run in the page.
 *
 * @param {any} scope the page's global object
 * @param {string} binding
 * @param {string} workletSource
 * @param {boolean} record also send what the page played, as a compressed recording
 */
export function installSoundTap(scope, binding, workletSource, record) {
  const send = scope[binding]
  if (typeof send !== 'function' || typeof scope.AudioContext !== 'function') return
  const clock = scope.performance
  const emit = (event) => {
    try {
      send(JSON.stringify(event))
    } catch {
      // The driver went away; the page carries on.
    }
  }
  const failed = (error, id) =>
    emit({ id, type: 'tap-failed', atMs: clock.now(), error: String(error) })

  let context
  let ready = false
  let recording = null
  /** Elements met before the audio thread's half had loaded. */
  const waiting = []
  const ids = new WeakMap()
  let lastId = 0

  // The audio thread stamps a stretch in the context's own time. The context
  // also says which of its moments is leaving for the output right now, and
  // when that is on the page's clock — asked per event, because the two
  // clocks drift.
  const toPageMs = (contextSec) => {
    const stamp = context.getOutputTimestamp()
    if (stamp && stamp.performanceTime > 0) {
      return stamp.performanceTime + (contextSec - stamp.contextTime) * 1000
    }
    return clock.now() + (contextSec - context.currentTime) * 1000
  }

  const connect = (element, id) => {
    try {
      const source = context.createMediaElementSource(element)
      const follower = new scope.AudioWorkletNode(context, 'pc-envelope')
      const mute = context.createGain()
      mute.gain.value = 0
      // The element sounds as it did: straight to the output.
      source.connect(context.destination)
      // And is listened to. The follower's own output goes nowhere audible,
      // but it has to go somewhere, or the graph stops running it.
      source.connect(follower)
      follower.connect(mute)
      mute.connect(context.destination)
      if (recording) source.connect(recording)
      follower.port.onmessage = (message) => {
        const { type, timeSec, peak } = message.data
        emit({ id, type, atMs: toPageMs(timeSec), peak })
      }
    } catch (error) {
      failed(error, id)
    }
  }

  const describe = (element) => ({
    positionMs: element.currentTime * 1000,
    volume: element.muted ? 0 : element.volume,
    durationMs: Number.isFinite(element.duration) ? element.duration * 1000 : null,
  })

  const wire = (element) => {
    const known = ids.get(element)
    if (known) return known
    const id = (lastId += 1)
    ids.set(element, id)
    for (const type of ['playing', 'pause', 'ended', 'emptied', 'volumechange']) {
      element.addEventListener(type, () =>
        emit({ id, type, atMs: clock.now(), ...describe(element) }),
      )
    }
    // The element's own account of trouble. Nothing is judged from these;
    // they are what explains a clip that sat without playing.
    for (const type of ['waiting', 'stalled', 'suspend', 'error', 'abort']) {
      element.addEventListener(type, () =>
        emit({
          id,
          type,
          atMs: clock.now(),
          positionMs: element.currentTime * 1000,
          readyState: element.readyState,
          networkState: element.networkState,
          error: element.error ? `${element.error.code}: ${element.error.message}` : null,
        }),
      )
    }
    if (ready) connect(element, id)
    else waiting.push([element, id])
    return id
  }

  try {
    // Made as the page loads, seconds before any clip plays, so that the
    // audio thread's half is in place when the first one does.
    context = new scope.AudioContext()
    if (record) recording = context.createMediaStreamDestination()
    const module = scope.URL.createObjectURL(
      new scope.Blob([workletSource], { type: 'text/javascript' }),
    )
    context.audioWorklet
      .addModule(module)
      .then(() => context.resume())
      .then(() => {
        ready = true
        for (const [element, id] of waiting.splice(0)) connect(element, id)
        emit({
          type: 'tap-ready',
          atMs: clock.now(),
          state: context.state,
          sampleRate: context.sampleRate,
          baseLatencyMs: context.baseLatency * 1000,
          outputLatencyMs: (context.outputLatency ?? 0) * 1000,
        })
      })
      .catch(failed)
  } catch (error) {
    failed(error)
    return
  }

  if (recording) {
    try {
      const recorder = new scope.MediaRecorder(recording.stream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 48_000,
      })
      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return
        const reader = new scope.FileReader()
        // A data URL: `data:audio/webm;…;base64,<the bytes>`.
        reader.onload = () =>
          emit({ type: 'recording', atMs: clock.now(), data: String(reader.result).split(',')[1] })
        reader.readAsDataURL(event.data)
      }
      recorder.start(5_000)
      // For the driver to call before it closes the page: the last few
      // seconds are otherwise still in the recorder.
      scope.__pcStopRecording = () => recorder.stop()
    } catch (error) {
      failed(error)
    }
  }

  // Every element the page makes with `new Audio()` — which is how the app's
  // player makes all of them — is wired as it is made, before it can sound.
  const NativeAudio = scope.Audio
  scope.Audio = function Audio(...args) {
    const element = new NativeAudio(...args)
    wire(element)
    return element
  }
  scope.Audio.prototype = NativeAudio.prototype

  // And every play is reported, however the element was made. The unit is a
  // play, not an element: a cached player replays one element many times.
  const media = scope.HTMLMediaElement.prototype
  const nativePlay = media.play
  media.play = function play(...args) {
    const id = wire(this)
    const source = String(this.currentSrc || this.src || '')
    emit({
      id,
      type: 'play',
      atMs: clock.now(),
      src: source.slice(source.lastIndexOf('/') + 1),
      ...describe(this),
    })
    return nativePlay.apply(this, args)
  }
}

/**
 * `installSoundTap` as text, to run in a page before anything else does.
 *
 * @param {{ record?: boolean }} [options]
 */
export const soundTapSource = ({ record = false } = {}) =>
  `(${installSoundTap.toString()})(globalThis, ${JSON.stringify(SOUND_BINDING)}, ${JSON.stringify(ENVELOPE_WORKLET_SOURCE)}, ${record})`
