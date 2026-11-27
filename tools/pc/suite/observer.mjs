// The app's own playback observer, held against what the page played.
//
// Two measurements of the same plays, made two ways. The app times its
// players by their status events (`PlaybackObserver`, read in a browser
// through `observedStatus.web.ts`); the suite listens to the audio elements
// themselves. Where they agree, each is evidence for the other — and where
// they do not, one of them is wrong and it is worth knowing which.
//
// Reported, never judged. A browser tells the app where a playhead is about
// four times a second, so the observer first sees a clip some way into it;
// it logs how far (`positionAtOnsetMs`), and the subtraction that turns
// "first seen" into "began" is made here, not in the app.
import { fieldsOf, recordsOf } from './capture.mjs'
import { spread } from './stats.mjs'

/**
 * @typedef {object} HeardPlay what the page did for one play the app logged
 * @property {string | null} playId the app's id for the play
 * @property {import('./sound.mjs').ElementPlay | null} first the element play that began it
 * @property {import('./sound.mjs').ElementPlay | null} last the one that ended it — the same, but for a ceremony
 */

const finite = (v) => (Number.isFinite(v) ? v : null)

/**
 * Every play the observer closed, against the element that played it.
 *
 * - `startMs`: when the observer says the clip began (its onset less the
 *   position the playhead had reached) minus when the element said it was
 *   playing.
 * - `endMs`: when the observer closed the play minus when the element
 *   stopped. Only for a play the observer saw end by itself.
 * - `firstSeenMs`: how far into the clip the observer first saw it.
 *
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 * @param {HeardPlay[]} heard
 */
export function observerReport(records, heard) {
  const byId = new Map(heard.filter((h) => h.playId !== null).map((h) => [h.playId, h]))
  const outcomes = {}
  const notCompared = {}
  const startMs = []
  const endMs = []
  const firstSeenMs = []
  /** Plays the page sounded and the observer never saw start. */
  const unseen = []
  /** Plays the observer saw start on an element that made no sound. */
  const unheard = []
  let compared = 0
  const observed = recordsOf(records, 'workout.voice.observed').map(fieldsOf)
  for (const o of observed) {
    const outcome = String(o.outcome ?? 'unknown')
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    const match = byId.get(o.playId)
    if (!match || match.first === null) {
      const kind = String(o.kind ?? 'unknown')
      notCompared[kind] = (notCompared[kind] ?? 0) + 1
      continue
    }
    compared += 1
    const onset = finite(o.onsetMs)
    const position = finite(o.positionAtOnsetMs)
    const sounded = match.first.sound.length > 0
    const name = { playId: o.playId, kind: o.kind ?? null, label: o.label ?? null, outcome }
    if (onset === null) {
      if (sounded) unseen.push(name)
      continue
    }
    // Volume 0 is a clip ducked on purpose: it plays, and nothing sounds.
    if (!sounded && o.silentByVolume !== true) unheard.push(name)
    if (position !== null) {
      firstSeenMs.push(position)
      if (match.first.playingAtMs !== null) startMs.push(onset - position - match.first.playingAtMs)
    }
    const end = finite(o.endMs)
    if (outcome === 'ok' && end !== null && match.last?.stoppedAtMs != null) {
      endMs.push(end - match.last.stoppedAtMs)
    }
  }
  return {
    records: observed.length,
    outcomes,
    compared,
    /** Plays with no element to hold them against, by kind — the metronome, mostly. */
    notCompared,
    startMs: spread(startMs),
    endMs: spread(endMs),
    firstSeenMs: spread(firstSeenMs),
    unseen,
    unheard,
  }
}

const cell = (v) => (v === null || v === undefined ? '—' : String(v))
const row = (label, s) =>
  `| ${label} | ${s.n} | ${cell(s.minMs)} | ${cell(s.medianMs)} | ${cell(s.p95Ms)} | ${cell(s.maxMs)} |`
const tally = (counts) =>
  Object.entries(counts)
    .map(([key, n]) => `${n} ${key}`)
    .join(', ') || 'none'

/**
 * The cross-check as lines for the drive's sound report.
 *
 * @param {ReturnType<typeof observerReport>} report
 * @returns {string[]}
 */
export function renderObserver(report) {
  if (report.records === 0) {
    return ['## The app’s own observer', '', 'The app logged no observed plays in this run.', '']
  }
  const named = (p) => `${p.kind ?? 'play'} “${p.label ?? p.playId}” (${p.outcome})`
  return [
    '## The app’s own observer',
    '',
    `The app timed ${report.records} plays by its players’ status events (${tally(report.outcomes)}); ${report.compared} of them could be held against an audio element${
      Object.keys(report.notCompared).length > 0
        ? ` — not ${tally(report.notCompared)}, which this suite does not follow`
        : ''
    }.`,
    '',
    '| observer − element, ms | n | least | median | p95 | most |',
    '|---|---|---|---|---|---|',
    row('began (onset less the position first seen)', report.startMs),
    row('ended', report.endMs),
    row('how far into the clip it was first seen', report.firstSeenMs),
    '',
    ...(report.unseen.length > 0
      ? [
          `Sounded, and the observer never saw them start (${report.unseen.length}):`,
          ...report.unseen.slice(0, 8).map((p) => `- ${named(p)}`),
          '',
        ]
      : []),
    ...(report.unheard.length > 0
      ? [
          `Seen to start by the observer, and no sound came (${report.unheard.length}):`,
          ...report.unheard.slice(0, 8).map((p) => `- ${named(p)}`),
          '',
        ]
      : []),
    'Reported, not judged. A browser reports a playhead about four times a second, so the observer first sees a clip some way in; the first row has that taken off.',
    '',
  ]
}
