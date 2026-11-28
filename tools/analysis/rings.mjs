// The rings: did every one light, and when.
//
// A bar's rings light one by one as the work clock passes each one's time.
// The app paints them from a clock it reads on every animation frame, and
// logs each step (`workout.ring.visual`) and each new bar
// (`workout.ring.promote`). It also logs when its 50 ms loop reached each
// ring's time (`workout.cue.tokenDue`), which is the schedule: the ring's
// own time on the work clock, and the device's clock at that moment.
//
// Order is not judged, because it cannot go wrong: the code that paints the
// rings only ever moves forward within a bar. What can go wrong is a ring
// that is late, or one that never lights — a frame that came too late
// steps over a ring, and a bar that is promoted late loses its last ones.
//
// Two clocks are in play, and the check exists because they can disagree.
// The SESSION clock schedules the calls and the ring tokens. The RING clock
// is the UI thread's copy of it, and the rings are painted from that. A ring
// step logs both: the frame's own time (`frameMs`) and the work-elapsed the
// ring clock read on that frame (`workElapsedMs`). The frame's time against
// the session clock's schedule is how late the ring really was. The ring
// clock's reading against the schedule is how late the ring clock thinks it
// was — and before N-18 was fixed those were 35 ms and 2.8 ms. The gap
// between them is the two clocks disagreeing, and it is judged here.
//
// This is the core, and it knows nothing about where a capture came from.
// It is handed plain lists; the PC suite builds them from a page's records
// (`tools/pc/suite/rings.mjs`), a device capture builds them from logcat.
import { fitWorkAxis } from './observed-timing.mjs'
import { spread } from './stats.mjs'
import { detectViolations } from './token-forensics.mjs'

/**
 * A ring painted this long after its scheduled time is a ring the eye sees
 * late. Not a tablet figure and not measured against one. It was set when a
 * ring on this PC was ordinarily painted some 54 ms after its time and the
 * worst in 22 runs was 68; with N-18 fixed those are about 4 and 21.
 */
export const RING_LATE_WARN_MS = 100
/** A ring whose time came this close to the end of the capture may simply not have been painted yet. */
export const TAIL_MS = 500
/**
 * The ring clock and the session clock may differ by this much before it is
 * a finding: a little over one 60 Hz frame. They are one clock by design, so
 * what remains is the two readings being taken a moment apart.
 */
export const RING_CLOCK_SKEW_WARN_MS = 20

/**
 * @typedef {object} RingStep
 * @property {string} cueId
 * @property {number} ordinal  the ring stepped to; -1 clears the row
 * @property {number} atMs  when the record was written, on the tokens' clock
 * @property {number} [frameMs]  the frame that lit the ring, on the same clock
 * @property {number} [workElapsedMs]  what the ring clock read on that frame
 * @property {number} [from]  the ring stepped from
 * @property {string} [row]  'lit' | 'masked' | 'other'
 *
 * @typedef {object} RingInput
 * @property {Array<{ roundIndex: number, cueId: string, ordinal: number, scheduledMs: number, workElapsedMs?: number, monotonicTimeMs?: number }>} tokens
 *   every `cue.tokenDue`, as logged
 * @property {Array<{ transition?: string, roundIndex?: number, workElapsedMs?: number, monotonicTimeMs?: number }>} boundaries
 *   every `round.boundary`, as logged
 * @property {RingStep[]} painted  every `ring.visual`
 * @property {unknown[]} promotes  each `ring.promote`'s `lateMs`
 * @property {Array<Record<string, any>>} viz  the app's forensic records, parsed
 * @property {number} lastMs  the last moment the capture covers, on that clock
 */

/** @param {RingInput} input */
export function ringReportFrom({ tokens: allTokens, boundaries, painted: steps, promotes, viz, lastMs }) {
  const tokens = allTokens.filter((t) => t.ordinal >= 0)
  const fit = fitWorkAxis(tokens, boundaries)
  /** When each ring was due, on the capture's clock: `cue/ordinal` → ms. */
  const due = new Map()
  /** The same moment on the work clock. */
  const scheduled = new Map()
  /** The rings of each bar that were due, by cue. */
  const bars = new Map()
  for (const t of tokens) {
    const offsetMs = fit.get(t.roundIndex)?.offsetMs
    if (offsetMs === null || offsetMs === undefined) continue
    const dueMs = t.scheduledMs + offsetMs
    if (dueMs > lastMs - TAIL_MS) continue
    due.set(`${t.cueId}/${t.ordinal}`, dueMs)
    scheduled.set(`${t.cueId}/${t.ordinal}`, t.scheduledMs)
    bars.set(t.cueId, [...(bars.get(t.cueId) ?? []), t.ordinal])
  }
  /** The first step to each ring of each bar: cue → ordinal → step. */
  const painted = new Map()
  for (const step of steps) {
    if (step.ordinal < 0) continue
    const of = painted.get(step.cueId) ?? new Map()
    if (!of.has(step.ordinal)) of.set(step.ordinal, step)
    painted.set(step.cueId, of)
  }
  const unlit = []
  const skipped = []
  const lateness = []
  const late = []
  /** Lateness by round, and the two clocks' disagreement by round. */
  const byRound = new Map()
  const skewByRound = new Map()
  const ringClockLate = []
  const rows = { lit: 0, masked: 0, other: 0, unrecorded: 0 }
  let stamped = 0
  const roundOf = new Map(tokens.map((t) => [`${t.cueId}/${t.ordinal}`, t.roundIndex]))
  for (const [cueId, ordinals] of bars) {
    const lit = painted.get(cueId) ?? new Map()
    const reached = lit.size === 0 ? -1 : Math.max(...lit.keys())
    const expected = Math.max(...ordinals)
    // The walk stopped short of the bar's last ring: those rings never lit.
    if (reached < expected) unlit.push({ cueId, reached, expected })
    for (const ordinal of ordinals) {
      const key = `${cueId}/${ordinal}`
      const step = lit.get(ordinal)
      if (step === undefined) {
        // Lit along with a later ring: a frame came late and stepped over it.
        if (ordinal < reached) skipped.push({ cueId, ordinal })
        continue
      }
      // The frame that lit it, where the record says; when the record was
      // written, where it does not (a capture from before it did).
      const hasFrame = Number.isFinite(step.frameMs)
      const lateMs = (hasFrame ? step.frameMs : step.atMs) - due.get(key)
      lateness.push(lateMs)
      const round = roundOf.get(key)
      byRound.set(round, [...(byRound.get(round) ?? []), lateMs])
      if (lateMs > RING_LATE_WARN_MS) late.push({ cueId, ordinal, lateMs: Math.round(lateMs) })
      if (hasFrame) stamped += 1
      if (hasFrame && Number.isFinite(step.workElapsedMs)) {
        const onRingClock = step.workElapsedMs - scheduled.get(key)
        ringClockLate.push(onRingClock)
        skewByRound.set(round, [...(skewByRound.get(round) ?? []), lateMs - onRingClock])
      }
      if (step.row === 'lit' || step.row === 'masked' || step.row === 'other') rows[step.row] += 1
      else rows.unrecorded += 1
    }
  }
  const loop = detectViolations(viz)
  const count = (kind) => loop.violations.filter((v) => v.kind === kind).length
  const perRound = (map) =>
    [...map].sort(([a], [b]) => a - b).map(([roundIndex, values]) => ({ roundIndex, ...spread(values) }))
  return {
    bars: bars.size,
    rings: due.size,
    /** Rings the walk reached. Whether light was shown is `rows`. */
    lit: lateness.length + skipped.length,
    unlit,
    skipped,
    late,
    /** A ring's painting after its scheduled time, on the session clock. */
    paintedLate: spread(lateness),
    /** The same, round by round: `[{ roundIndex, n, medianMs, … }]`. */
    paintedLateByRound: perRound(byRound),
    /** How many rings were timed by the frame that lit them rather than by when the record was written. */
    stamped,
    /** The same lateness as the ring clock itself saw it. */
    ringClockLate: spread(ringClockLate),
    /** How far the ring clock ran behind the session clock, round by round. */
    ringClockSkewByRound: perRound(skewByRound),
    /**
     * What was on stage when each ring was stepped to: `lit` painted it;
     * `masked` is a row the app holds dim on purpose; `other` is another bar's
     * row; `unrecorded` is a capture from before the record said.
     */
    rows,
    /** How late the app's own frame clock says each bar was promoted. */
    promotedLate: spread(promotes),
    /** The app's 50 ms loop, from its forensics records — not the painted rings. */
    loop: {
      records: viz.length,
      relight: count('re-light'),
      backtrack: count('backtrack'),
      burst: count('burst') + count('cue-burst'),
      // A clock record is written for a gap of four missed ticks or more, and
      // also each time the work clock starts again at a new round. Only the
      // first is a stall.
      stalls: viz.filter((v) => v.kind === 'clock' && v.workDeltaMs >= 0).length,
    },
  }
}

/**
 * The ring report as a verdict. Hard: a bar whose rings did not all light.
 * Soft: a ring stepped over; a ring painted late; the ring clock running
 * apart from the session clock; the app's loop catching up after a stall; a
 * run with no forensics records to read.
 *
 * @param {ReturnType<typeof ringReportFrom>} report
 * @returns {{ verdict: 'PASS' | 'WARN' | 'FAIL', hard: string[], soft: string[] }}
 */
export function ringVerdict(report) {
  const hard = []
  const soft = []
  if (report.unlit.length > 0) {
    const u = report.unlit[0]
    hard.push(
      `${report.unlit.length} bar(s) did not light all their rings — first: ${u.cueId} reached ring ${u.reached + 1} of ${u.expected + 1}`,
    )
  }
  if (report.skipped.length > 0) {
    const s = report.skipped[0]
    soft.push(
      `${report.skipped.length} ring(s) were stepped over by a late frame — first: ring ${s.ordinal + 1} of ${s.cueId}`,
    )
  }
  if (report.late.length > 0) {
    const worst = [...report.late].sort((a, b) => b.lateMs - a.lateMs)[0]
    soft.push(
      `${report.late.length} ring(s) were painted more than ${RING_LATE_WARN_MS} ms after their time — worst: ring ${worst.ordinal + 1} of ${worst.cueId}, ${worst.lateMs} ms`,
    )
  }
  const apart = (report.ringClockSkewByRound ?? []).filter((r) => Math.abs(r.medianMs ?? 0) > RING_CLOCK_SKEW_WARN_MS)
  if (apart.length > 0) {
    const each = apart.map((r) => `round ${r.roundIndex + 1} by ${r.medianMs} ms`).join(', ')
    soft.push(
      `the ring clock ran apart from the session clock — ${each}. The rings are painted that long after the schedule the calls keep, and the ring clock's own reading does not show it`,
    )
  }
  const { loop } = report
  if (loop.records === 0) {
    soft.push('the app logged no forensics records, so its loop could not be checked')
  }
  if (loop.relight + loop.backtrack + loop.burst + loop.stalls > 0) {
    soft.push(
      `the app’s loop stalled and caught up: ${loop.stalls} stall(s), ${loop.burst} burst(s), ${loop.relight + loop.backtrack} token(s) out of order — its 50 ms loop, not the painted rings`,
    )
  }
  return { verdict: hard.length > 0 ? 'FAIL' : soft.length > 0 ? 'WARN' : 'PASS', hard, soft }
}
