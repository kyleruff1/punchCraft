/**
 * A database as a build at migration 004 left it: two finished sessions, each
 * with a generated workout and graded cues; one plan never run; one punch a
 * cue was matched to.
 *
 * Shared, so the upgrade can be run on more than one engine: the tablet's
 * kind (`upgradePath.migration.test.ts`, on node:sqlite) and the PC's
 * (`sqlJsPort.test.ts`, on sql.js). Apply it to a database migrated through
 * 004 and no further.
 *
 * Not a test file itself — jest.config.js excludes `__tests__/helpers/`.
 */
import type { SqlPort } from '@/storage/SqlPort'

export const REALIZED_S1 = JSON.stringify([{ blockId: 'b1', tokens: ['1', '2'] }])
export const REALIZED_S2 = JSON.stringify([
  { blockId: 'b1', tokens: ['1', '2'] },
  { blockId: 'b2', tokens: ['3'] },
])

export function seedAsOfMigration004(db: Pick<SqlPort, 'execSync'>): void {
  db.execSync(`
    INSERT INTO sessions (id, mode, status, active_duration_ms, created_at) VALUES
      ('s1', 'punchcraft', 'completed', 180000, '2026-08-24T10:00:00.000Z'),
      ('s2', 'punchcraft', 'cancelled',  42000, '2026-08-25T10:00:00.000Z');
    INSERT INTO workout_recipes
      (id, name, default_stance, params_json, recipe_schema_version, created_at, updated_at)
      VALUES ('r1', 'Default', 'orthodox', '{"durationMinutes":20}', 1, 't0', 't0');
    INSERT INTO generated_workouts
      (id, recipe_id, session_id, generator_version, seed,
       params_snapshot_json, blocks_json, realized_tokens_json, created_at) VALUES
      ('w1', 'r1', 's1', '1.0.0', 'seed-a', '{"durationMinutes":20}', '{"schedule":[]}', '${REALIZED_S1}', '2026-08-24T10:03:00.000Z'),
      ('w2', 'r1', 's2', '1.0.0', 'seed-b', '{"durationMinutes":20}', '{"schedule":[]}', '${REALIZED_S2}', '2026-08-25T10:01:00.000Z'),
      ('w3', 'r1', NULL, '1.0.0', 'seed-c', '{"durationMinutes":20}', '{"schedule":[]}', '[]',             '2026-08-26T10:00:00.000Z');
    INSERT INTO punch_events
      (id, source_frame_id, device_address, hand, tracker_timestamp_ms,
       received_monotonic_time_ms, received_wall_time_iso, punch_type_raw,
       velocity_raw, velocity_unit, decoder_id, decoder_version) VALUES
      ('p1', 'f1', 'D7:34:B4:27:D5:84', 'left', 1000, 5000, '2026-08-24T10:00:05.000Z', 1, 7, 'tracker-unit', 'fightcamp-v1', '1.0.0');
    INSERT INTO workout_adaptations
      (id, generated_workout_id, decided_at_monotonic_ms, boundary, inputs_json, decision_json)
      VALUES ('a1', 'w1', 60000, 'round', '{}', '{"cadence":"hold"}');
    INSERT INTO cue_results
      (session_id, generated_workout_id, block_id, token_index, expected_hand,
       observed_event_id, outcome, offset_ms, velocity_raw, capability_tier,
       decoder_version, calculation_version) VALUES
      ('s1', 'w1', 'b1', 0, 'left',  'p1', 'matched',  40, 7,    'hand-timestamp', '1.0.0', '1.0.0'),
      ('s1', 'w1', 'b1', 1, 'right', NULL, 'missed', NULL, NULL, 'hand-timestamp', '1.0.0', '1.0.0'),
      ('s2', 'w2', 'b1', 0, 'left',  NULL, 'late',    310, NULL, 'hand-timestamp', '1.0.0', '1.0.0');
  `)
}
