/**
 * Migration 010 — a pacing decision belongs to the session it was made in.
 *
 * `workout_adaptations` was keyed by the plan alone (004). A plan is shared:
 * two sessions of the same workout write one `generated_workouts` row, so
 * their decisions pooled under it, and nothing could say which session had
 * made which. Worse, a discarded session left its decisions behind — the
 * session row and everything hanging from it went, and the adaptation rows,
 * hanging from the plan, stayed for the next session of that workout to
 * inherit (finding N-12).
 *
 * `session_id` names the session. It follows the session out when the
 * session is deleted, by the same cascade its cue results use, so no delete
 * path — today's Discard or one written later — has to remember it.
 *
 * It is nullable on purpose. Rows written before this have none, and none
 * can be worked out for them: the monotonic stamp they carry restarts on
 * every launch. They are left exactly where they are, under their plan.
 *
 * One `ALTER TABLE … ADD COLUMN`, as 008 and 009 were — the table stays put
 * and every existing reference stays valid (007 records what a rebuild of a
 * referenced table costs on the tablet). A column added with a reference
 * must default to NULL, which is the default wanted anyway.
 */

import type { SQLiteDatabase } from 'expo-sqlite'

import type { Migration } from './index'

export const MIGRATION_010: Migration = {
  id: 10,
  name: 'adaptation_session',
  up(db: SQLiteDatabase): void {
    db.execSync(
      'ALTER TABLE workout_adaptations ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE',
    )
  },
}
