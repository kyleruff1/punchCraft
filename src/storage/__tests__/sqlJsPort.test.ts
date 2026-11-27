/**
 * The PC's storage engine: the app's port over sql.js, against the real
 * engine and the real migrations.
 *
 * The tablet stores through expo-sqlite; every other storage suite stands in
 * for that with node:sqlite. A browser gets neither, so this suite is the
 * evidence that the schema, the upgrade path and the repositories behave on
 * the engine the PC version actually uses.
 */
import type { SQLiteDatabase } from 'expo-sqlite'
import initSqlJs, { type SqlJsStatic } from 'sql.js'

import { replaceSinks } from '@diagnostics/logger'
import { threeRoundFundamentals } from '@domain/workout/samples'
import { MIGRATIONS_FOR_TESTS, runMigrations } from '@/storage/migrations'
import { SessionRepository } from '@/storage/repositories/SessionRepository'
import { SettingsRepository } from '@/storage/repositories/SettingsRepository'
import { WorkoutRepository } from '@/storage/repositories/WorkoutRepository'
import { SETTINGS_KEYS } from '@/storage/migrations/006_app_settings'
import { createSqlJsPort, type SqlJsPort } from '@/storage/sqlJsPort'

import { REALIZED_S1, seedAsOfMigration004 } from './helpers/upgradeFixture'

let SQL: SqlJsStatic
beforeAll(async () => {
  replaceSinks([])
  SQL = await initSqlJs()
})

const open = (bytes?: Uint8Array): SqlJsPort => createSqlJsPort(new SQL.Database(bytes))
const asSqlite = (db: SqlJsPort): SQLiteDatabase => db as unknown as SQLiteDatabase
const query = <T = Record<string, unknown>>(
  db: SqlJsPort,
  sql: string,
  params: never[] = [],
): T[] => {
  const stmt = db.prepareSync(sql)
  try {
    return stmt.executeSync<T>(params).getAllSync()
  } finally {
    stmt.finalizeSync()
  }
}
const migrated = (): SqlJsPort => {
  const db = open()
  runMigrations(asSqlite(db))
  return db
}
const plannedStream = () =>
  threeRoundFundamentals.schedule.flatMap((round) =>
    round.blocks.map((block) => ({ blockId: block.id, tokens: block.tokens })),
  )

describe('the engine', () => {
  it('is new enough for the migrations (DROP COLUMN needs SQLite 3.35)', () => {
    const [{ v }] = query<{ v: string }>(open(), 'SELECT sqlite_version() AS v') as [{ v: string }]
    const [major, minor] = v.split('.').map(Number) as [number, number]
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(3035)
  })

  it('runs every migration through the real runner', () => {
    const db = migrated()
    const applied = query<{ id: number }>(db, 'SELECT id FROM schema_migrations ORDER BY id')
    expect(applied.map((r) => r.id)).toEqual(
      MIGRATIONS_FOR_TESTS.map((m) => m.id).sort((a, b) => a - b),
    )
  })
})

describe('an upgrade on this engine', () => {
  it('carries a database from migration 004 to the current schema, data intact', () => {
    const db = open()
    runMigrations(asSqlite(db), { through: 4 })
    seedAsOfMigration004(db)
    runMigrations(asSqlite(db))

    // 005 rebuilt cue_results and kept every row; 007 moved each session's
    // realized stream into workout_runs and dropped the two columns.
    expect(query(db, 'SELECT * FROM cue_results')).toHaveLength(3)
    expect(
      query<{ session_id: string; realized_tokens_json: string }>(
        db,
        'SELECT session_id, realized_tokens_json FROM workout_runs ORDER BY session_id',
      )[0],
    ).toEqual({ session_id: 's1', realized_tokens_json: REALIZED_S1 })
    expect(
      query<{ name: string }>(db, 'PRAGMA table_info(generated_workouts)').map((r) => r.name),
    ).not.toContain('realized_tokens_json')
    // 009 added a column and backfilled nothing.
    expect(
      query<{ live_counts_json: string | null }>(db, 'SELECT live_counts_json FROM sessions'),
    ).toEqual(expect.arrayContaining([{ live_counts_json: null }]))
    expect(query(db, 'PRAGMA foreign_key_check')).toEqual([])
    expect(new WorkoutRepository(db).getWorkoutBySession('s1')?.realized).toEqual(
      JSON.parse(REALIZED_S1),
    )
  })

  it('sends an adaptation out with its session on this engine too (010)', () => {
    const db = open()
    runMigrations(asSqlite(db), { through: 4 })
    seedAsOfMigration004(db)
    runMigrations(asSqlite(db))
    const count = (): number =>
      query<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM workout_adaptations')[0]!.n
    const before = count()
    const workouts = new WorkoutRepository(db)
    workouts.appendAdaptation({
      generatedWorkoutId: 'w1',
      sessionId: 's1',
      decidedAtMonotonicMs: 5,
      boundary: 'rest',
      inputs: {},
      decision: {},
    })
    expect(count()).toBe(before + 1)

    db.execSync(`DELETE FROM sessions WHERE id = 's1'`)

    // The new row left with its session; what was there before stayed.
    expect(count()).toBe(before)
    expect(workouts.listAdaptationsForSession('s1')).toEqual([])
    expect(query(db, 'PRAGMA foreign_key_check')).toEqual([])
  })
})

describe('the repositories', () => {
  it('store and read a setting', () => {
    const settings = new SettingsRepository(migrated())
    settings.write(SETTINGS_KEYS.capture, { keepRawFrames: false })
    expect(
      settings.readChecked(SETTINGS_KEYS.capture, (s) => ({
        keepRawFrames: s['keepRawFrames'] !== false,
      })).value,
    ).toEqual({ keepRawFrames: false })
  })

  it('read back a whole workout — a result far past the 255 bytes the other web engine could return', () => {
    const db = migrated()
    new SessionRepository(db).create({ id: 'ses-1', mode: 'punchcraft' })
    const workouts = new WorkoutRepository(db)
    workouts.saveGeneratedWorkout(threeRoundFundamentals, plannedStream(), 'ses-1')

    const found = workouts.getWorkoutBySession('ses-1')
    expect(found?.workout).toEqual(threeRoundFundamentals)
    expect(JSON.stringify(found).length).toBeGreaterThan(10_000)
  })
})

describe('exporting the database', () => {
  const orphanCue = (db: SqlJsPort): void =>
    db.execSync(`
      INSERT INTO cue_results
        (session_id, generated_workout_id, block_id, token_index, expected_hand,
         outcome, capability_tier, decoder_version, calculation_version)
      VALUES ('no-session', 'no-workout', 'b1', 0, 'left', 'missed', 'hand-timestamp', '1', '1')`)

  it('round-trips: the bytes reopen as the same database', () => {
    const db = migrated()
    new SettingsRepository(db).write(SETTINGS_KEYS.qa, { enabled: true })
    const bytes = db.exportBytes()
    expect(bytes).not.toBeNull()

    const reopened = open(bytes!)
    expect(
      new SettingsRepository(reopened).readChecked(SETTINGS_KEYS.qa, (s) => ({
        enabled: s['enabled'] === true,
      })).value,
    ).toEqual({ enabled: true })
    // And it is already at the current schema: nothing left to migrate.
    runMigrations(asSqlite(reopened))
    expect(query(reopened, 'SELECT id FROM schema_migrations')).toHaveLength(
      MIGRATIONS_FOR_TESTS.length,
    )
  })

  it('still enforces foreign keys afterwards', () => {
    const db = migrated()
    expect(() => orphanCue(db)).toThrow(/FOREIGN KEY/i)
    db.exportBytes()
    expect(query<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys')[0]?.foreign_keys).toBe(1)
    expect(() => orphanCue(db)).toThrow(/FOREIGN KEY/i)
  })

  it('enforces them on a database reopened from bytes, too', () => {
    const reopened = open(migrated().exportBytes()!)
    expect(() => orphanCue(reopened)).toThrow(/FOREIGN KEY/i)
  })

  it('refuses inside a transaction, and leaves the transaction alone', () => {
    const db = migrated()
    const settings = new SettingsRepository(db)
    db.execSync('BEGIN')
    settings.write(SETTINGS_KEYS.qa, { enabled: true })
    expect(db.exportBytes()).toBeNull()
    db.execSync('ROLLBACK')
    // The write was rolled back by us — not lost to an export — and the
    // database is usable and exportable again.
    expect(
      settings.readChecked(SETTINGS_KEYS.qa, (s) => ({ enabled: s['enabled'] === true })).value,
    ).toEqual({
      enabled: false,
    })
    expect(db.exportBytes()).not.toBeNull()
  })

  it('refuses inside a savepoint as well', () => {
    const db = migrated()
    db.execSync('SAVEPOINT sp')
    expect(db.exportBytes()).toBeNull()
    db.execSync('RELEASE sp')
    expect(db.exportBytes()).not.toBeNull()
  })
})

describe('knowing when there is something to save', () => {
  it('counts writes, not reads — and an export does not reset the count', () => {
    const db = migrated()
    const afterMigrations = db.writeCount()
    expect(afterMigrations).toBeGreaterThan(0)

    query(db, 'SELECT COUNT(*) AS n FROM sessions')
    db.execSync('PRAGMA foreign_keys')
    expect(db.writeCount()).toBe(afterMigrations)

    new SettingsRepository(db).write(SETTINGS_KEYS.qa, { enabled: true })
    const afterWrite = db.writeCount()
    expect(afterWrite).toBeGreaterThan(afterMigrations)
    db.exportBytes()
    expect(db.writeCount()).toBe(afterWrite)
  })

  it('tells its listener about each write, and not about reads', () => {
    const db = migrated()
    let writes = 0
    db.onWrite(() => (writes += 1))
    query(db, 'SELECT 1')
    expect(writes).toBe(0)
    new SettingsRepository(db).write(SETTINGS_KEYS.qa, { enabled: true })
    expect(writes).toBeGreaterThan(0)
  })
})
