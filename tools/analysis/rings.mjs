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
// This is the core, and it knows nothing about where a capture came from.
// It is handed plain lists; the PC suite builds them from a page's records
// (`tools/pc/suite/rings.mjs`), a device capture builds them from logcat.
import { fitWorkAxis } from './observed-timing.mjs'
import { spread } from './stats.mjs'
import { detectViolations } from './token-forensics.mjs'

/**
 * A ring painted this long after its scheduled time is a ring the eye sees
 * late. Not a tablet figure and not measured against one: it is about two
 * frames more than the worst ring in 22 runs on this PC (68 ms), where a
 * ring is ordinarily painted some 54 ms after its time.
 */
export const RING_LATE_WARN_MS = 100
/** A ring whose time came this close to the end of the capture may simply not have been painted yet. */
export const TAIL_MS = 500

/**
 * @typedef {object} RingInput
 * @property {Array<{ roundIndex: number, cueId: string, ordinal: number, scheduledMs: number, workElapsedMs?: number, monotonicTimeMs?: number }>} tokens
 *   every `cue.tokenDue`, as logged
 * @property {Array<{ transition?: string, roundIndex?: number, workElapsedMs?: number, monotonicTimeMs?: number }>} boundaries
 *   every `round.boundary`, as logged
 * @property {Array<{ cueId: string, ordinal: number, atMs: number }>} painted
 *   every `ring.visual`, with when it happened on the tokens' clock
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
  /** The rings of each bar that were due, by cue. */
  const bars = new Map()
  for (const t of tokens) {
    const offsetMs = fit.get(t.roundIndex)?.offsetMs
    if (offsetMs === null || offsetMs === undefined) continue
    const dueMs = t.scheduledMs + offsetMs
    if (dueMs > lastMs - TAIL_MS) continue
    due.set(`${t.cueId}/${t.ordinal}`, dueMs)
    bars.set(t.cueId, [...(bars.get(t.cueId) ?? []), t.ordinal])
  }
  /** The rings each bar was painted through, and when: cue → ordinal → ms. */
  const painted = new Map()
  for (const { cueId, ordinal, atMs } of steps) {
    if (ordinal < 0) continue
    const of = painted.get(cueId) ?? new Map()
    if (!of.has(ordinal)) of.set(ordinal, atMs)
    painted.set(cueId, of)
  }
  const unlit = []
  const skipped = []
  const lateness = []
  const late = []
  /** Lateness by round: the rings of round 1 are painted later than the rest. */
  const byRound = new Map()
  const roundOf = new Map(tokens.map((t) => [`${t.cueId}/${t.ordinal}`, t.roundIndex]))
  for (const [cueId, ordinals] of bars) {
    const lit = painted.get(cueId) ?? new Map()
    const reached = lit.size === 0 ? -1 : Math.max(...lit.keys())
    const expected = Math.max(...ordinals)
    // The walk stopped short of the bar's last ring: those rings never lit.
    if (reached < expected) unlit.push({ cueId, reached, expected })
    for (const ordinal of ordinals) {
      if (lit.has(ordinal)) {
        const lateMs = lit.get(ordinal) - due.get(`${cueId}/${ordinal}`)
        lateness.push(lateMs)
        const round = roundOf.get(`${cueId}/${ordinal}`)
        byRound.set(round, [...(byRound.get(round) ?? []), lateMs])
        if (lateMs > RING_LATE_WARN_MS) late.push({ cueId, ordinal, lateMs: Math.round(lateMs) })
      } else if (ordinal < reached) {
        // Lit along with a later ring: a frame came late and stepped over it.
        skipped.push({ cueId, ordinal })
      }
    }
  }
  const loop = detectViolations(viz)
  const count = (kind) => loop.violations.filter((v) => v.kind === kind).length
  return {
    bars: bars.size,
    rings: due.size,
    lit: lateness.length + skipped.length,
    unlit,
    skipped,
    late,
    /** A ring's painting after its scheduled time, on the capture's clock. */
    paintedLate: spread(lateness),
    /** The same, round by round: `[{ roundIndex, n, medianMs, … }]`. */
    paintedLateByRound: [...byRound]
      .sort(([a], [b]) => a - b)
      .map(([roundIndex, values]) => ({ roundIndex, ...spread(values) })),
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
 * Soft: a ring stepped over; a ring painted late; the app's loop catching
 * up after a stall; a run with no forensics records to read.
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
