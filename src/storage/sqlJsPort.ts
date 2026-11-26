/**
 * The app's storage port over sql.js — SQLite compiled to WebAssembly, which
 * runs synchronously on the calling thread.
 *
 * ## Why the PC version does not use expo-sqlite
 *
 * Every storage call in this app is synchronous (`SqlPort`). expo-sqlite's
 * web build answers a synchronous call by posting to a worker and waiting on
 * a shared buffer, and the pinned version (57.0.2, unchanged in 57.0.7)
 * writes the result's length into that buffer with
 * `resultArray.set(new Uint32Array([length]), 0)` — one element, so one
 * byte. Any result of 256 bytes or more is truncated and fails to parse.
 * Settings load; saving a workout fails with "Unterminated string in JSON".
 * Found by running the web build, 2026-11-26.
 *
 * sql.js has no worker to hand a result back from. The tablet keeps
 * expo-sqlite, untouched; this is `database.web.ts`'s engine and nothing
 * else's.
 *
 * ## What sql.js makes this file's business
 *
 * - The database lives in memory. `exportBytes()` is the whole file, for
 *   `database.web.ts` to write to the browser's storage.
 * - Foreign keys are OFF by default in this build of SQLite, as in every
 *   other; the port switches them on for the life of the connection.
 * - `export()` throws inside a transaction ("SQLite is busy or locked").
 *   `exportBytes()` asks first and returns null instead, so the caller can
 *   simply try again later.
 * - In sql.js 1.17.0 an export leaves PRAGMAs as they were (checked: the
 *   test that holds foreign keys across an export passes without the
 *   re-apply below). They are re-applied anyway. An engine that reopened the
 *   database on export would switch foreign keys off without a sound, and
 *   one statement is cheaper than discovering that after an upgrade.
 *
 * Pure TypeScript over a structural slice of sql.js's API: it runs in jest
 * against the real engine, with the real migrations.
 */
import type { SqlBindValue, SqlPort, SqlStatement } from './SqlPort'

/** The slice of sql.js's `Statement` this uses. */
export interface SqlJsStatement {
  bind(values: Array<string | number | null | Uint8Array>): boolean
  step(): boolean
  getAsObject(): Record<string, unknown>
  reset(): void
  free(): boolean
}

/** The slice of sql.js's `Database` this uses. */
export interface SqlJsDatabase {
  run(sql: string): unknown
  prepare(sql: string): SqlJsStatement
  export(): Uint8Array
  close(): void
}

export interface SqlJsPort extends SqlPort {
  /** The whole database as a file's bytes, or null inside a transaction. */
  exportBytes(): Uint8Array | null
  /**
   * How many statements that may have changed the database have run. It only
   * ever goes up, so "is there anything unsaved" is a comparison with the
   * count taken when the last save was exported — one that a failed save, or
   * a write landing while a save is in flight, cannot get wrong.
   */
  writeCount(): number
  /** Called after each statement that may have changed the database. */
  onWrite(listener: () => void): void
  close(): void
}

/** PRAGMAs that must hold for the life of the connection. */
const CONNECTION_PRAGMAS = 'PRAGMA foreign_keys = ON;'

/**
 * Statements that cannot have changed anything. Only used to decide whether
 * an export is owed, and deliberately narrow: calling a read a write costs
 * one spare export, calling a write a read would lose it.
 */
const READ_ONLY = /^\s*(SELECT|EXPLAIN|PRAGMA\s+\w+\s*;?\s*$)/i

const toBind = (v: SqlBindValue): string | number | null | Uint8Array =>
  typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v

export function createSqlJsPort(db: SqlJsDatabase): SqlJsPort {
  const listeners: Array<() => void> = []
  let writes = 0

  db.run(CONNECTION_PRAGMAS)

  const wrote = (): void => {
    writes += 1
    for (const listener of listeners) listener()
  }
  /**
   * Whether a transaction is open — asked of the engine, not worked out from
   * the SQL that went past: SQLite refuses a BEGIN inside a transaction,
   * however that transaction was started (BEGIN, SAVEPOINT, half a script).
   */
  const inTransaction = (): boolean => {
    try {
      db.run('BEGIN')
    } catch {
      return true
    }
    db.run('ROLLBACK')
    return false
  }

  return {
    execSync(sql) {
      db.run(sql)
      if (!READ_ONLY.test(sql)) wrote()
    },

    prepareSync(sql): SqlStatement {
      const stmt = db.prepare(sql)
      const readOnly = READ_ONLY.test(sql)
      return {
        // Params default to none: `runMigrations` makes a bare call, as the
        // real driver allows (see `memoryDb.ts`).
        executeSync: <TRow = unknown>(params: SqlBindValue[] = []) => {
          stmt.reset()
          stmt.bind(params.map(toBind))
          const rows: TRow[] = []
          while (stmt.step()) rows.push(stmt.getAsObject() as TRow)
          stmt.reset()
          if (!readOnly) wrote()
          return { getAllSync: () => rows }
        },
        finalizeSync: () => {
          stmt.free()
        },
      }
    },

    exportBytes() {
      if (inTransaction()) return null
      const bytes = db.export()
      // Belt and braces — see the header.
      db.run(CONNECTION_PRAGMAS)
      return bytes
    },

    writeCount: () => writes,

    onWrite(listener) {
      listeners.push(listener)
    },

    close() {
      db.close()
    },
  }
}
