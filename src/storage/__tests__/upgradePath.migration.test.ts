/**
 * What an UPGRADE does to a database that already has data in it.
 *
 * Every other storage suite builds its database by calling each migration's
 * `up()` on an empty file. That proves the final schema; it cannot prove
 * that 005's table rebuild keeps the rows it copies, that 007's backfill
 * finds the sessions it is meant to, or that dropping two columns from a
 * populated table leaves the rest readable — and it runs none of it through
 * the real runner. The tablet is not an empty file.
 *
 * So: run the real runner up to 004, write what a build of that era wrote,
 * run the rest, and look at what is left.
 *
 * It also makes "a shipped migration is append-only" executable. That rule
 * lives in a comment in `migrations/index.ts`, and on 2026-11-25 a rename
 * edited migration 003's CHECK constraint anyway — see `SESSION_MODES`.
 */
import { createHash } from 'node:crypto'

import type { SQLiteDatabase } from 'expo-sqlite'

import { replaceSinks } from '@diagnostics/logger'
import { MIGRATIONS_FOR_TESTS, runMigrations } from '@/storage/migrations'
import { SessionRepository } from '@/storage/repositories/SessionRepository'
import { WorkoutRepository } from '@/storage/repositories/WorkoutRepository'

import { MemoryDb } from './helpers/memoryDb'

beforeAll(() => {
  replaceSinks([])
})

const asSqlite = (db: MemoryDb): SQLiteDatabase => db as unknown as SQLiteDatabase
const appliedIds = (db: MemoryDb): number[] =>
  db.query<{ id: number }>('SELECT id FROM schema_migrations ORDER BY id').map((r) => r.id)
const columns = (db: MemoryDb, table: string): string[] =>
  db.query<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name)

const REALIZED_S1 = JSON.stringify([{ blockId: 'b1', tokens: ['1', '2'] }])
const REALIZED_S2 = JSON.stringify([{ blockId: 'b1', tokens: ['1', '2'] }, { blockId: 'b2', tokens: ['3'] }])

/**
 * A database as a build at migration 004 left it: two finished sessions,
 * each with a generated workout and graded cues; one plan never run; one
 * punch a cue was matched to.
 */
function databaseAtMigration004(): MemoryDb {
  const db = new MemoryDb()
  runMigrations(asSqlite(db), { through: 4 })
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
  return db
}

describe('the runner can stop at an older schema', () => {
  it('applies exactly the migrations up to the one named', () => {
    const db = new MemoryDb()
    runMigrations(asSqlite(db), { through: 4 })
    expect(appliedIds(db)).toEqual([1, 2, 3, 4])
    // 004's shape, not today's: the columns 007 drops are still here, and
    // the tables later migrations add are not.
    expect(columns(db, 'generated_workouts')).toEqual(
      expect.arrayContaining(['session_id', 'realized_tokens_json']),
    )
    expect(columns(db, 'cue_results')).not.toContain('repeat_index')
    expect(db.count(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'workout_runs'`)).toBe(0)
  })

  it('carries on from there to the current schema, and is then a no-op', () => {
    const db = new MemoryDb()
    runMigrations(asSqlite(db), { through: 4 })
    runMigrations(asSqlite(db))
    const all = MIGRATIONS_FOR_TESTS.map((m) => m.id)
    expect(appliedIds(db)).toEqual(all)
    runMigrations(asSqlite(db))
    expect(appliedIds(db)).toEqual(all)
  })
})

describe('upgrading a database that already holds sessions (004 → current)', () => {
  let db: MemoryDb
  let before: { cues: Record<string, unknown>[]; punches: Record<string, unknown>[] }

  beforeEach(() => {
    db = databaseAtMigration004()
    before = {
      cues: db.query('SELECT * FROM cue_results ORDER BY session_id, block_id, token_index'),
      punches: db.query('SELECT * FROM punch_events ORDER BY id'),
    }
    runMigrations(asSqlite(db))
  })

  it('keeps every graded cue through the cue_results rebuild, as rep 0', () => {
    const after = db.query<Record<string, unknown>>(
      'SELECT * FROM cue_results ORDER BY session_id, block_id, token_index',
    )
    expect(after).toHaveLength(3)
    expect(after.map(({ repeat_index: _rep, ...row }) => row)).toEqual(before.cues)
    expect(after.map((row) => row.repeat_index)).toEqual([0, 0, 0])
  })

  it('leaves the rebuilt table keyed on the repetition too', () => {
    const insert = (rep: number): void =>
      db.execSync(`
        INSERT INTO cue_results
          (session_id, generated_workout_id, block_id, repeat_index, token_index,
           expected_hand, outcome, capability_tier, decoder_version, calculation_version)
        VALUES ('s1', 'w1', 'b1', ${rep}, 0, 'left', 'matched', 'hand-timestamp', '1.0.0', '1.1.0')`)
    expect(() => insert(1)).not.toThrow()
    expect(() => insert(0)).toThrow(/UNIQUE|PRIMARY/i)
  })

  it('moves each session’s realized stream into workout_runs', () => {
    expect(
      db.query('SELECT * FROM workout_runs ORDER BY session_id'),
    ).toEqual([
      { session_id: 's1', generated_workout_id: 'w1', realized_tokens_json: REALIZED_S1, created_at: '2026-08-24T10:03:00.000Z' },
      { session_id: 's2', generated_workout_id: 'w2', realized_tokens_json: REALIZED_S2, created_at: '2026-08-25T10:01:00.000Z' },
    ])
  })

  it('keeps every plan, including one no session ran, and drops only the two moved columns', () => {
    expect(db.query<{ id: string }>('SELECT id FROM generated_workouts ORDER BY id').map((r) => r.id)).toEqual(['w1', 'w2', 'w3'])
    const cols = columns(db, 'generated_workouts')
    expect(cols).not.toContain('session_id')
    expect(cols).not.toContain('realized_tokens_json')
    expect(cols).toEqual(expect.arrayContaining(['recipe_id', 'generator_version', 'seed', 'params_snapshot_json', 'blocks_json']))
  })

  it('keeps punches and adaptations, with the new acceleration column empty', () => {
    const after = db.query<Record<string, unknown>>('SELECT * FROM punch_events ORDER BY id')
    expect(after.map(({ acceleration_raw: _acc, ...row }) => row)).toEqual(before.punches)
    expect(after.map((row) => row.acceleration_raw)).toEqual([null])
    expect(db.count('SELECT COUNT(*) AS n FROM workout_adaptations')).toBe(1)
  })

  it('leaves no dangling reference and a sound file', () => {
    expect(db.query('PRAGMA foreign_key_check')).toEqual([])
    expect(db.query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })

  it('is readable through the repositories the app uses', () => {
    const workouts = new WorkoutRepository(db)
    const found = workouts.getWorkoutBySession('s1')
    expect(found?.workout.id).toBe('w1')
    expect(found?.realized).toEqual(JSON.parse(REALIZED_S1))
    expect(new SessionRepository(db).getById('s2')?.status).toBe('cancelled')
  })

  it('still cascades a deleted session to its cues and its run, and keeps the plan', () => {
    new SessionRepository(db).delete('s1')
    expect(db.count(`SELECT COUNT(*) AS n FROM cue_results WHERE session_id = 's1'`)).toBe(0)
    expect(db.count(`SELECT COUNT(*) AS n FROM workout_runs WHERE session_id = 's1'`)).toBe(0)
    expect(db.count(`SELECT COUNT(*) AS n FROM generated_workouts WHERE id = 'w1'`)).toBe(1)
    expect(db.count(`SELECT COUNT(*) AS n FROM cue_results WHERE session_id = 's2'`)).toBe(1)
  })
})

describe('a shipped migration is append-only', () => {
  /**
   * The SQL each migration executes, reduced to a fingerprint.
   *
   * `schema_migrations` records that a migration RAN, never what it ran, so
   * editing one changes the schema of every future install and of no
   * existing one. Nothing fails: the tests build their database from the
   * edited file and agree with it. This is the tripwire.
   *
   * If it fires because you changed a migration: put it back and write a
   * new one. If you ADDED a migration: append its fingerprint here in the
   * same change, and never touch the line again.
   */
  // Computed from the files on `main` at 8b7e79a2 (the last commit before
  // the rename), not from this working tree.
  const SHIPPED: Record<number, string> = {
    1: 'd7fedf0924931032',
    2: '46cf62b3f13c8116',
    3: 'a7053e769de9a026',
    4: '86f392da8b940d07',
    5: 'f346ad1fe12edd2f',
    6: 'ce02d426373a93e0',
    7: '679518b61440d0d0',
    8: '5a15032a09306812',
  }

  /** Whitespace and SQL comments do not change a schema; everything else does. */
  const fingerprint = (id: number): string => {
    const migration = MIGRATIONS_FOR_TESTS.find((m) => m.id === id)
    if (!migration) throw new Error(`no migration ${id}`)
    const executed: string[] = []
    const recorder = { execSync: (sql: string) => void executed.push(sql) }
    migration.up(recorder as unknown as SQLiteDatabase)
    const normalized = executed
      .join('\n;\n')
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
  }

  it('has a fingerprint on record for every migration', () => {
    expect(Object.keys(SHIPPED).map(Number)).toEqual(MIGRATIONS_FOR_TESTS.map((m) => m.id))
  })

  it.each(MIGRATIONS_FOR_TESTS.map((m) => [m.id, m.name] as const))(
    'migration %i (%s) executes the SQL it shipped with',
    (id) => {
      expect(fingerprint(id)).toBe(SHIPPED[id])
    },
  )

  it('accepts the three session modes 003 shipped with, and not the renamed one', () => {
    const db = new MemoryDb()
    runMigrations(asSqlite(db))
    const insert = (mode: string): void =>
      db.execSync(`INSERT INTO sessions (id, mode, status, created_at) VALUES ('${mode}', '${mode}', 'completed', 't')`)
    for (const mode of ['velocity-test', 'punchcraft', 'puncheokie']) expect(() => insert(mode)).not.toThrow()
    expect(() => insert('workouts')).toThrow(/CHECK/i)
  })
})
