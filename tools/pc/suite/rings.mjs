// The rings, from what a page logged.
//
// The check itself is `tools/analysis/rings.mjs`, shared with the tablet's
// suite. This is the PC's way in: the page's records already carry the
// moment each was written on the page's own clock, so a ring's painting is
// simply the time of its `workout.ring.visual` record.
import { ringReportFrom } from '../../analysis/rings.mjs'
import { fieldsOf, recordsOf } from './capture.mjs'

export { RING_LATE_WARN_MS, ringVerdict, TAIL_MS } from '../../analysis/rings.mjs'

/**
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 */
export function ringReport(records) {
  return ringReportFrom({
    tokens: recordsOf(records, 'workout.cue.tokenDue').map(fieldsOf),
    boundaries: recordsOf(records, 'workout.round.boundary').map(fieldsOf),
    painted: recordsOf(records, 'workout.ring.visual').map((r) => {
      const { cueId, ordinal } = fieldsOf(r)
      return { cueId, ordinal, atMs: r.monoMs }
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
