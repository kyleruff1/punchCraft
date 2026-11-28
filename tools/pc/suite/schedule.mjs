// What a capture says was scheduled in each round — read the same way from a
// device's capture and from the PC's, because both are in the tablet's layout
// and both go through the tablet's parser.
//
// This is the part of a workout that the two must agree on exactly. Which
// clip, in what order, at what time on the work clock, leading which ring:
// all of it is decided by code they share and none of it depends on how fast
// the device is. How *late* each was sent does depend on the device, and is
// kept apart as a figure to set side by side, never to compare.
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

/**
 * @typedef {object} RoundSchedule one round of a capture
 * @property {number} roundIndex 0-based
 * @property {boolean} whole the capture holds the round to the boundary that closes it
 * @property {Dispatch[]} dispatches
 * @property {number} tokensDue
 * @property {ReturnType<typeof spread>} dispatchLateMs
 * @property {ReturnType<typeof spread>} ringTokenLateMs
 */

const fields = (text, code, read) => recordsWithTag(text, code).map((r) => read(r.body))
const whole = (v) => (v === undefined ? undefined : Math.round(v))
/** The boundaries that close a round: its rest beginning, or the workout ending. */
const CLOSES_A_ROUND = new Set(['rest-entered', 'completed'])

/**
 * What a capture says was scheduled, round by round. Null when the capture
 * never reached a round.
 *
 * `rounds` is every round the capture opened, in order; a round is `whole`
 * when the boundary that closes it was captured too. The default PC drive
 * stops three seconds into round 2, and those three seconds are not a round
 * to compare with anything.
 *
 * `dispatches` and `tokensDue` are round 1's, as they always were. The two
 * lateness figures are over every whole round — round 1 alone, for a drive
 * of round 1 — or over round 1 when the capture holds none whole.
 *
 * Records are placed in a round by their own monotonic stamp, not by the log
 * line's clock: at the bell, two records a millisecond apart can be written
 * in either order.
 *
 * @param {string} logcatText
 * @returns {{ rounds: RoundSchedule[], dispatches: Dispatch[], tokensDue: number, dispatchLateMs: ReturnType<typeof spread>, ringTokenLateMs: ReturnType<typeof spread> } | null}
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
  const windows = roundWindows(boundaries, tokenDue).sort((a, b) => a.roundIndex - b.roundIndex)
  if (!windows.some((w) => w.roundIndex === 0)) return null

  const plays = fields(logcatText, 'workout.voice.play', (b) => ({
    kind: extractField(b, 'kind'),
    text: extractField(b, 'text'),
    traceId: extractField(b, 'traceId'),
    dispatchMs: numField(b, 'dispatchMs'),
  })).filter((play) => play.kind === 'click-script')
  const sent = fields(logcatText, 'workout.clickScript.dispatch', (b) => ({
    kind: extractField(b, 'kind'),
    slot: extractField(b, 'slot'),
    traceId: extractField(b, 'traceId'),
    dispatchAtMs: numField(b, 'dispatchAtMs'),
    durationMs: numField(b, 'durationMs'),
    firstNodeMs: numField(b, 'firstNodeMs'),
    lateMs: numField(b, 'lateMs'),
    monotonicTimeMs: numField(b, 'monotonicTimeMs'),
  }))
  const closing = boundaries
    .filter((b) => b.monotonicTimeMs !== undefined)
    .sort((a, b) => a.monotonicTimeMs - b.monotonicTimeMs)

  const rounds = windows.map((window) => {
    const inRound = (at) => at !== undefined && at >= window.startMs && at < window.endMs
    // The boundary that ends the round's window: its own rest, the workout's
    // end — or a cancel, which ends it without completing it.
    const end = closing.find(
      (b) =>
        b.monotonicTimeMs > window.startMs &&
        (b.transition !== 'work-entered' || b.roundIndex !== window.roundIndex),
    )
    /** What each dispatch said, by its trace id — unique within a round. */
    const said = new Map()
    for (const play of plays) {
      if (inRound(play.dispatchMs)) said.set(play.traceId, play.text ?? null)
    }
    const dispatched = sent.filter((d) => inRound(d.monotonicTimeMs))
    const ringTokens = tokenDue.filter((t) => t.roundIndex === window.roundIndex)
    return {
      roundIndex: window.roundIndex,
      whole:
        end !== undefined &&
        end.monotonicTimeMs <= window.endMs &&
        CLOSES_A_ROUND.has(end.transition),
      dispatches: dispatched.map((d) => ({
        kind: d.kind,
        slot: d.slot,
        dispatchAtMs: whole(d.dispatchAtMs),
        durationMs: whole(d.durationMs),
        firstNodeMs: whole(d.firstNodeMs),
        text: said.get(d.traceId) ?? null,
      })),
      tokensDue: ringTokens.length,
      late: {
        dispatch: dispatched.map((d) => d.lateMs),
        ringToken: ringTokens.map((t) => t.workElapsedMs - t.scheduledMs),
      },
    }
  })

  const first = rounds.find((r) => r.roundIndex === 0)
  const measured = rounds.some((r) => r.whole) ? rounds.filter((r) => r.whole) : [first]
  return {
    rounds: rounds.map(({ late, ...round }) => ({
      ...round,
      dispatchLateMs: spread(late.dispatch),
      ringTokenLateMs: spread(late.ringToken),
    })),
    dispatches: first.dispatches,
    tokensDue: first.tokensDue,
    dispatchLateMs: spread(measured.flatMap((r) => r.late.dispatch)),
    ringTokenLateMs: spread(measured.flatMap((r) => r.late.ringToken)),
  }
}

/** One dispatch as a line of text: what must be the same on both devices. */
export const dispatchKey = (d) =>
  `${d.kind} ${d.slot} @${d.dispatchAtMs} ${d.durationMs}ms ring@${d.firstNodeMs}${d.text === null ? '' : ` “${d.text}”`}`
