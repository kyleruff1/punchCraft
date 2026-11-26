/**
 * SQLite bootstrap for punchcraft.
 *
 * Opens the shared on-device database (expo-sqlite) with WAL journaling and
 * foreign keys enabled, then applies pending migrations. Storage is
 * deliberately decoupled from the BLE transport — nothing in this module,
 * or the migrations/repositories it fans out to, may import from src/ble/**.
 */

import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite'

import { logger, safe } from '@/diagnostics/logger'
import { runMigrations } from '@/storage/migrations'

const DB_NAME = 'punchcraft.db'

let dbInstance: SQLiteDatabase | null = null

/**
 * Open the punchcraft database (idempotent within the process). Configures
 * PRAGMAs and runs migrations on first open.
 */
export function openDatabase(): SQLiteDatabase {
  if (dbInstance) return dbInstance
  const db = openDatabaseSync(DB_NAME)
  // WAL gives us concurrent readers alongside the capture writer; foreign
  // keys must be enabled per-connection since the default is OFF.
  db.execSync('PRAGMA journal_mode = WAL;')
  db.execSync('PRAGMA foreign_keys = ON;')
  runMigrations(db)
  dbInstance = db
  logger.info('storage.open', 'punchcraft.db opened', { name: safe(DB_NAME) })
  return db
}

/**
 * Resolves when `openDatabase()` may be called. On the tablet that is always:
 * the native database opens synchronously, so this is already done. It exists
 * for the browser, where the engine and the saved file load asynchronously
 * (`database.web.ts`) and the root layout has to wait.
 */
export function prepareStorage(): Promise<void> {
  return Promise.resolve()
}

/** Whether `openDatabase()` may be called now. Always, on the tablet. */
export function isStorageReady(): boolean {
  return true
}

/** Reset the process-wide handle. Intended for tests. */
export function __resetDatabaseForTests(): void {
  dbInstance = null
}
