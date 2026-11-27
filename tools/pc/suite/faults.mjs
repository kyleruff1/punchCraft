// Breaking the app on purpose.
//
// A gate that has only ever been seen to pass has not been shown to work.
// Each fault here makes the page do one thing the sound gate exists to
// catch, while the app goes on believing it played every clip — so the log
// stays clean, the correlator still passes, and the only thing that can
// fail the drive is the gate under test.
//
//   npm run pc:suite -- --only quick-one-two --fault mute    a call that makes no sound
//   npm run pc:suite -- --only quick-one-two --fault cut     a call that stops early
//   npm run pc:suite -- --only quick-one-two --fault late    a call that starts late and runs into its ring
//
//   npm run pc:suite -- --only quick-one-two --fault mute-bell   every bell rung in silence
//   npm run pc:suite -- --only quick-one-two --fault cut-countdown   each countdown clip stopped half a second in
//
// The first three touch every fourth play of a call: a short clip on a
// reused player, played from a downloaded copy — which is how a call is told
// from a bell or a silence file, both short too. It has to be installed before
// the sound tap, so that the tap still reports the play at the moment the
// app asked for it and the fault sits between that and the real `play()`.

export const FAULTS = ['mute', 'cut', 'late', 'mute-bell', 'cut-countdown']

/** A clip shorter than this is a call; lead-ins run to several seconds. */
export const CALL_MAX_SEC = 2
/** `cut` stops the clip this long after it starts. */
export const CUT_AFTER_MS = 300
/** `late` holds the clip back this long. */
export const LATE_BY_MS = 700
/** One play in this many is broken. */
export const EVERY = 4

/**
 * Self-contained: it is turned into text and run in the page.
 *
 * @param {any} scope the page's global object
 * @param {string} kind one of `FAULTS`
 * @param {{ callMaxSec: number, cutAfterMs: number, lateByMs: number, every: number }} how
 */
export function installFault(scope, kind, how) {
  const media = scope.HTMLMediaElement.prototype
  const nativePlay = media.play
  const nativePause = media.pause
  let seen = 0
  // The app parks a call's player once the clip should be over, which stops
  // a late clip before it can reach its ring — the app's own protection. To
  // show the gate a call that does reach its ring, `late` has to get past
  // that once: the next pause of a held-back element is dropped.
  const heldBack = new scope.WeakSet()
  /** @this {any} the element */
  media.pause = function pause() {
    if (heldBack.has(this)) {
      heldBack.delete(this)
      return undefined
    }
    return nativePause.call(this)
  }
  /** @this {any} the element */
  media.play = function play(...args) {
    const source = String(this.currentSrc || this.src || '')
    if (kind === 'mute-bell') {
      // The build's own file, by name.
      if (/\/bell\.[^/]*$/.test(source)) this.muted = true
      return nativePlay.apply(this, args)
    }
    if (kind === 'cut-countdown') {
      // The countdown's own clips, by name. A stopped clip never ends, so
      // the app's playlist never starts the next one either.
      if (/\/warn-[^/]*$/.test(source))
        scope.setTimeout(() => nativePause.call(this), how.cutAfterMs)
      return nativePlay.apply(this, args)
    }
    const call =
      Number.isFinite(this.duration) && this.duration < how.callMaxSec && source.startsWith('blob:')
    if (!call) return nativePlay.apply(this, args)
    seen += 1
    if (seen % how.every !== 0) {
      // An element this fault muted earlier is given its voice back.
      if (kind === 'mute') this.muted = false
      return nativePlay.apply(this, args)
    }
    if (kind === 'mute') {
      this.muted = true
      return nativePlay.apply(this, args)
    }
    if (kind === 'cut') {
      scope.setTimeout(() => nativePause.call(this), how.cutAfterMs)
      return nativePlay.apply(this, args)
    }
    // late
    heldBack.add(this)
    return new scope.Promise((resolve, reject) => {
      scope.setTimeout(() => nativePlay.apply(this, args).then(resolve, reject), how.lateByMs)
    })
  }
}

/**
 * `installFault` as text, to run in a page before the sound tap.
 *
 * @param {string} kind
 */
export function faultSource(kind) {
  if (!FAULTS.includes(kind)) throw new Error(`a fault is one of ${FAULTS.join(', ')}, not ${kind}`)
  const how = {
    callMaxSec: CALL_MAX_SEC,
    cutAfterMs: CUT_AFTER_MS,
    lateByMs: LATE_BY_MS,
    every: EVERY,
  }
  return `(${installFault.toString()})(globalThis, ${JSON.stringify(kind)}, ${JSON.stringify(how)})`
}
