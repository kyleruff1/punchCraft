/**
 * Migration 009 — keep what the live screen counted with the session.
 *
 * A saved workout stored only the punches that answered a called
 * combination (`cue_results`, and the punch events they name). Everything
 * else the athlete saw on the counter was lost at save: punches thrown in an
 * open burst (a count-scored cue writes no rows), extra punches, and the
 * per-round totals on the bell cards. A summary rebuilt from a stored
 * session would therefore show a lower total than the bell did, and a burst
 * round as "0 of N". Nobody saw it because nothing showed a stored session —
 * session history is the first thing that does.
 *
 * `live_counts_json` holds those counts as the live screen had them
 * (`src/domain/programs/liveCounts.ts` owns the shape and checks it on
 * read). It is nullable on purpose: NULL means "saved by a build before
 * this", which is how a screen tells *not recorded* from *zero*. Nothing is
 * backfilled — the numbers do not exist for older sessions.
 *
 * These are observations, not derived metrics: they cannot be recalculated,
 * because the punches behind them were never stored. `session_metrics`
 * stays MetricsEngine's (#117) and is not written here.
 */

import type { SQLiteDatabase } from 'expo-sqlite'

import type { Migration } from './index'

export const MIGRATION_009: Migration = {
  id: 9,
  name: 'session_live_counts',
  up(db: SQLiteDatabase): void {
    db.execSync('ALTER TABLE sessions ADD COLUMN live_counts_json TEXT')
  },
}
