// The rings, from what a page logged.
//
// The check itself is `tools/analysis/rings.mjs`, shared with the tablet's
// suite. This is the PC's way in. A ring step says which frame lit it; a
// stored run from before the record did is timed by when the page wrote the
// record, which the page stamps on its own clock.
import { ringReportFrom } from '../../analysis/rings.mjs'
import { fieldsOf, recordsOf } from './capture.mjs'

export {
  RING_CLOCK_SKEW_WARN_MS,
  RING_LATE_WARN_MS,
  ringVerdict,
  TAIL_MS,
} from '../../analysis/rings.mjs'

/**
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 */
export function ringReport(records) {
  return ringReportFrom({
    tokens: recordsOf(records, 'workout.cue.tokenDue').map(fieldsOf),
    boundaries: recordsOf(records, 'workout.round.boundary').map(fieldsOf),
    painted: recordsOf(records, 'workout.ring.visual').map((r) => {
      // The frame that lit the ring and what the ring clock read on it, when
      // the record carries them; a stored run from before it did has only the
      // moment the record was written, and the core falls back to that.
      const { cueId, ordinal, frameMs, workElapsedMs, from, row } = fieldsOf(r)
      return { cueId, ordinal, atMs: r.monoMs, frameMs, workElapsedMs, from, row }
    }),
    promotes: recordsOf(records, 'workout.ring.promote').map((r) => fieldsOf(r).lateMs),
    viz: recordsOf(records, 'workout.viz.batch').flatMap((r) => {
      try {
        return JSON.parse(fieldsOf(r).records)
      } catch {
        return []
      }
    }),
    lastMs: records.at(-1)?.monoMs ?? 0,
  })
}
