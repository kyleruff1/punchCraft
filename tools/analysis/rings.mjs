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
// A log is not always whole. A PC page's records are; a device's logcat
// drops lines under load (the tablet's September captures lose two to four
// ring records in a workout). So a ring with no record is only called unlit
// on a capture that loses nothing, or when the app itself says so: a step
// names the ring it stepped FROM, and a new bar says how far the last one
// got. Where a missing record is contradicted by one of those, the line was
// lost, not the ring.
//
// This is the core, and it knows nothing about where a capture came from.
// It is handed plain lists; `tools/pc/suite/rings.mjs` builds them from a
// page's records, `ringInputFromLogcat` below from a device capture.
import { extractField, numField, recordsWithTag } from './logcat.mjs'
import { fitWorkAxis, parseBoundaries, parseTokenDue } from './observed-timing.mjs'
import { spread } from './stats.mjs'
import { detectViolations, parseVizRecords } from './token-forensics.mjs'

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
 * @typedef {object} BarPromotion
 * @property {string} [previousCueId]  the bar before this one
 * @property {number} [previousReached]  the last ring that bar reached
 *
 * @typedef {object} RingInput
 * @property {Array<{ roundIndex: number, cueId: string, ordinal: number, scheduledMs: number, workElapsedMs?: number, monotonicTimeMs?: number }>} tokens
 *   every `cue.tokenDue`, as logged
 * @property {Array<{ transition?: string, roundIndex?: number, workElapsedMs?: number, monotonicTimeMs?: number }>} boundaries
 *   every `round.boundary`, as logged
 * @property {RingStep[]} painted  every `ring.visual`
 * @property {unknown[]} promotes  each `ring.promote`'s `lateMs`
 * @property {BarPromotion[]} [promotions]  each `ring.promote`'s account of the bar before
 * @property {Array<Record<string, any>>} viz  the app's forensic records, parsed
 * @property {number} lastMs  the last moment the capture covers, on that clock
 * @property {'page' | 'logcat'} [capture]
 *   a page's records are whole and stamped by the page; a logcat capture can
 *   lose lines and stamps them a thread-hop late. Default `'page'`.
 */

/** @param {RingInput} input */
export function ringReportFrom({ tokens: allTokens, boundaries, painted: steps, promotes, promotions = [], viz, lastMs, capture = 'page' }) {
  const lossless = capture === 'page'
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
  /** Rings a step says it came from: reached, whether or not their own record survived. */
  const cameFrom = new Set()
  /** Rings a step jumped clean over: it came from further back than the ring before it. */
  const jumped = new Set()
  for (const step of steps) {
    if (step.ordinal < 0) continue
    const of = painted.get(step.cueId) ?? new Map()
    if (!of.has(step.ordinal)) of.set(step.ordinal, step)
    painted.set(step.cueId, of)
    if (Number.isFinite(step.from)) {
      if (step.from >= 0) cameFrom.add(`${step.cueId}/${step.from}`)
      for (let over = step.from + 1; over < step.ordinal; over += 1) jumped.add(`${step.cueId}/${over}`)
    }
  }
  /** How far the app says each bar got, by the bar that followed it. */
  const reachedBy = new Map()
  for (const p of promotions) {
    if (p.previousCueId && Number.isFinite(p.previousReached)) reachedBy.set(p.previousCueId, p.previousReached)
  }

  const unlit = []
  const absent = []
  const skipped = []
  const lateness = []
  const recordLate = []
  const late = []
  /** Lateness by round, and the two clocks' disagreement by round. */
  const byRound = new Map()
  const skewByRound = new Map()
  const ringClockLate = []
  const rows = { lit: 0, masked: 0, other: 0, unrecorded: 0 }
  let stamped = 0
  let lostSteps = 0
  const roundOf = new Map(tokens.map((t) => [`${t.cueId}/${t.ordinal}`, t.roundIndex]))
  for (const [cueId, ordinals] of bars) {
    const lit = painted.get(cueId) ?? new Map()
    const recorded = lit.size === 0 ? -1 : Math.max(...lit.keys())
    const expected = Math.max(...ordinals)
    const said = reachedBy.get(cueId)
    if (said !== undefined && said < expected) {
      // The app's own account: the bar was left before its last ring.
      unlit.push({ cueId, reached: said, expected })
    } else if (said === undefined && recorded < expected) {
      // No account from the app. On a capture that loses nothing, silence
      // is the answer; on one that can lose lines, it is only a question.
      ;(lossless ? unlit : absent).push({ cueId, reached: recorded, expected })
    }
    for (const ordinal of ordinals) {
      const key = `${cueId}/${ordinal}`
      const step = lit.get(ordinal)
      if (step === undefined) {
        if (jumped.has(key)) {
          // A step says it came from before this ring: a frame stepped over it.
          skipped.push({ cueId, ordinal })
        } else if (cameFrom.has(key) || (said !== undefined && ordinal <= said)) {
          // Reached, by the app's own word; it is the record that is missing.
          lostSteps += 1
        } else if (ordinal < recorded) {
          // A later ring has a record and nothing says how this one was passed.
          if (lossless) skipped.push({ cueId, ordinal })
        }
        continue
      }
      const hasFrame = Number.isFinite(step.frameMs)
      if (!hasFrame && !lossless) {
        // A log line's time is when the line was written, a thread-hop after
        // the frame. It is reported, and never judged as the ring's time.
        recordLate.push(step.atMs - due.get(key))
      } else {
        // The frame that lit it, where the record says; when the page wrote
        // the record, on a stored page capture from before it did.
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
    lit: lateness.length + recordLate.length + skipped.length + lostSteps,
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
    /** Whether the capture can lose lines (`logcat`) or not (`page`). */
    capture,
    /**
     * On a capture that can lose lines: bars whose last rings have no record
     * and no word from the app either way. Unlit, or lost lines — the log
     * cannot say which.
     */
    absent,
    /** When a log line reached the log after its ring's time. Not the ring's time, and not judged. */
    recordLate: spread(recordLate),
    /** What the log is known to have lost. */
    lineLoss: { ringSteps: lostSteps, ...pairingLoss(tokens, viz) },
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
 * Lines a log is known to have lost, from two records the app writes in the
 * same tick for every ring token: `cue.tokenDue`, and a `token-due` entry in
 * a forensics batch. One without the other is a line that did not arrive.
 */
function pairingLoss(tokens, viz) {
  const fromViz = new Set(viz.filter((v) => v.source === 'token-due').map((v) => `${v.cueId}/${v.ordinal}`))
  // No forensics at all is its own finding; it says nothing about loss.
  if (fromViz.size === 0) return { tokenDue: 0, forensics: 0 }
  const fromTokens = new Set(tokens.map((t) => `${t.cueId}/${t.ordinal}`))
  return {
    tokenDue: [...fromViz].filter((key) => !fromTokens.has(key)).length,
    forensics: [...fromTokens].filter((key) => !fromViz.has(key)).length,
  }
}

/**
 * The ring report as a verdict. Hard: a bar whose rings did not all light.
 * Soft: a ring stepped over; a ring painted late; the ring clock running
 * apart from the session clock; rings with no record on a capture that loses
 * lines; the app's loop catching up after a stall; a run with no forensics
 * records to read.
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
  if ((report.absent ?? []).length > 0) {
    const a = report.absent[0]
    const loss = report.lineLoss ?? { ringSteps: 0, tokenDue: 0, forensics: 0 }
    const known = loss.ringSteps + loss.tokenDue + loss.forensics
    soft.push(
      `${report.absent.length} bar(s) have no record of their last rings lighting — first: ${a.cueId}, recorded to ring ${a.reached + 1} of ${a.expected + 1}. ` +
        `This log is known to have lost ${known} line(s) elsewhere, and it cannot say whether these are lost lines or unlit rings`,
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

// ---------------------------------------------------------------------------
// From a device capture
// ---------------------------------------------------------------------------

const median = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)]
}

/**
 * The check's input, from a device's `logcat.txt`.
 *
 * Everything is put on the app's own clock — the one `monotonicTimeMs` and
 * `frameMs` are written in. A log line's own time is the device's wall clock,
 * so it is carried across by the ring tokens, which are stamped with both:
 * the median difference is the offset. That is only ever used for a record
 * with no clock of its own — a ring step from a build before it carried one
 * — and for where the capture ends.
 *
 * @param {string} logcatText
 * @returns {RingInput}
 */
export function ringInputFromLogcat(logcatText) {
  const tokens = parseTokenDue(logcatText)
  const boundaries = parseBoundaries(logcatText)
  const wallToApp = median(tokens.map((t) => t.monotonicTimeMs - t.ts)) ?? 0
  const painted = recordsWithTag(logcatText, 'workout.ring.visual').map(({ ts, body }) => ({
    cueId: extractField(body, 'cueId'),
    ordinal: numField(body, 'ordinal'),
    atMs: ts + wallToApp,
    frameMs: numField(body, 'frameMs'),
    workElapsedMs: numField(body, 'workElapsedMs'),
    from: numField(body, 'from'),
    row: extractField(body, 'row'),
  }))
  const promoteRecords = recordsWithTag(logcatText, 'workout.ring.promote')
  const stamps = [
    ...tokens.map((t) => t.monotonicTimeMs),
    ...boundaries.map((b) => b.monotonicTimeMs),
    ...painted.map((p) => p.frameMs ?? p.atMs),
  ].filter((v) => Number.isFinite(v))
  return {
    tokens,
    boundaries,
    painted,
    promotes: promoteRecords.map(({ body }) => numField(body, 'lateMs')),
    promotions: promoteRecords.map(({ body }) => ({
      previousCueId: extractField(body, 'previousCueId'),
      previousReached: numField(body, 'previousReached'),
    })),
    viz: parseVizRecords(logcatText),
    lastMs: stamps.length === 0 ? 0 : Math.max(...stamps),
    capture: 'logcat',
  }
}

/** The ring report of a device capture. */
export function ringReportFromLogcat(logcatText) {
  return ringReportFrom(ringInputFromLogcat(logcatText))
}
