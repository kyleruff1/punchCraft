// What a capture says was scheduled in round 1 — read the same way from the
// tablet's capture and from the PC's, because both are in the tablet's
// layout and both go through the tablet's parser.
//
// This is the part of a workout that the two devices must agree on exactly.
// Which clip, in what order, at what time on the work clock, leading which
// ring: all of it is decided by code they share and none of it depends on
// how fast the device is. How *late* each was sent does depend on the device,
// and is kept apart as a figure to set side by side, never to compare.
import { extractField, numField, recordsWithTag } from '../../analysis/logcat.mjs'
import { roundWindows } from '../../analysis/observed-timing.mjs'
import { spread } from './stats.mjs'

/**
 * @typedef {object} Dispatch one clip sent to play, as scheduled
 * @property {string} kind `call` or `lead-in`
 * @property {string} slot which clip
 * @property {number} dispatchAtMs when it was due to be sent, on the round's work clock
 * @property {number} durationMs the clip's stated length
 * @property {number} firstNodeMs when the ring it leads is due, on the work clock
 * @property {string | null} text what was said, from the play record; null if that record is missing
 */

const fields = (text, code, read) => recordsWithTag(text, code).map((r) => read(r.body))
const whole = (v) => (v === undefined ? undefined : Math.round(v))

/**
 * Round 1 of a capture. Null when the capture never reached a round.
 *
 * Records are placed in the round by their own monotonic stamp, not by the
 * log line's clock: at the bell, two records a millisecond apart can be
 * written in either order.
 *
 * @param {string} logcatText
 * @returns {{ dispatches: Dispatch[], tokensDue: number, dispatchLateMs: ReturnType<typeof spread>, ringTokenLateMs: ReturnType<typeof spread> } | null}
 */
export function scheduleOf(logcatText) {
  const boundaries = fields(logcatText, 'workout.round.boundary', (b) => ({
    transition: extractField(b, 'transition'),
    roundIndex: numField(b, 'roundIndex'),
    workElapsedMs: numField(b, 'workElapsedMs'),
    monotonicTimeMs: numField(b, 'monotonicTimeMs'),
  }))
  const tokenDue = fields(logcatText, 'workout.cue.tokenDue', (b) => ({
    roundIndex: numField(b, 'roundIndex'),
    workElapsedMs: numField(b, 'workElapsedMs'),
    monotonicTimeMs: numField(b, 'monotonicTimeMs'),
    scheduledMs: numField(b, 'scheduledMs'),
  }))
  const first = roundWindows(boundaries, tokenDue).find((w) => w.roundIndex === 0)
  if (!first) return null
  const inRound = (at) => at !== undefined && at >= first.startMs && at < first.endMs

  /** What each dispatch said, by its trace id — unique within a round. */
  const said = new Map()
  for (const play of fields(logcatText, 'workout.voice.play', (b) => ({
    kind: extractField(b, 'kind'),
    text: extractField(b, 'text'),
    traceId: extractField(b, 'traceId'),
    dispatchMs: numField(b, 'dispatchMs'),
  }))) {
    if (play.kind === 'click-script' && inRound(play.dispatchMs))
      said.set(play.traceId, play.text ?? null)
  }
  const sent = fields(logcatText, 'workout.clickScript.dispatch', (b) => ({
    kind: extractField(b, 'kind'),
    slot: extractField(b, 'slot'),
    traceId: extractField(b, 'traceId'),
    dispatchAtMs: numField(b, 'dispatchAtMs'),
    durationMs: numField(b, 'durationMs'),
    firstNodeMs: numField(b, 'firstNodeMs'),
    lateMs: numField(b, 'lateMs'),
    monotonicTimeMs: numField(b, 'monotonicTimeMs'),
  })).filter((d) => inRound(d.monotonicTimeMs))
  const ringTokens = tokenDue.filter((t) => t.roundIndex === 0)
  return {
    dispatches: sent.map((d) => ({
      kind: d.kind,
      slot: d.slot,
      dispatchAtMs: whole(d.dispatchAtMs),
      durationMs: whole(d.durationMs),
      firstNodeMs: whole(d.firstNodeMs),
      text: said.get(d.traceId) ?? null,
    })),
    tokensDue: ringTokens.length,
    dispatchLateMs: spread(sent.map((d) => d.lateMs)),
    ringTokenLateMs: spread(ringTokens.map((t) => t.workElapsedMs - t.scheduledMs)),
  }
}

/** One dispatch as a line of text: what must be the same on both devices. */
export const dispatchKey = (d) =>
  `${d.kind} ${d.slot} @${d.dispatchAtMs} ${d.durationMs}ms ring@${d.firstNodeMs}${d.text === null ? '' : ` “${d.text}”`}`
