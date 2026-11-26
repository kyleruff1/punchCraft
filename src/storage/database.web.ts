/**
 * The app database in a browser — the PC version's `database.ts`.
 *
 * Metro picks this file over `database.ts` for the web build, so nothing
 * that imports `@storage/database` knows the difference: `openDatabase()`
 * still hands back a synchronous database with the migrations applied. What
 * is different is underneath (`sqlJsPort.ts` says why it is not expo-sqlite)
 * and around it:
 *
 * - **It has to be prepared first.** The engine is WebAssembly and the file
 *   lives in the browser's private storage; both load asynchronously, and
 *   every storage call in the app is synchronous. `prepareStorage()` does
 *   the loading once, and the root layout waits for it before mounting
 *   anything that could open the database.
 * - **It lives in memory and is saved as a whole.** After a write the
 *   database is exported and written to the origin-private file system,
 *   shortly afterwards and again when the page is hidden or closed. A crash
 *   or a closed tab loses at most the last second or so of writes. A save
 *   that fails is tried again, more slowly.
 * - **If the saved file will not open, the app still runs** — on an empty
 *   database, with an error in the log. The file that would not open is
 *   copied aside first (`UNREADABLE_FILE`); if even that fails, nothing is
 *   saved for the rest of the visit, so it is never overwritten unseen.
 *
 * Saving the whole file is fine for workouts and settings — a few hundred
 * kilobytes. It is the wrong shape for a glove's raw frames arriving many
 * times a second; when gloves reach the PC app, frames need their own way
 * to disk (or the Settings switch off).
 */
import type { SQLiteDatabase } from 'expo-sqlite'
import type { SqlJsStatic } from 'sql.js'
import initSqlJs from 'sql.js/dist/sql-wasm-browser.js'
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm'

import { logger, safe } from '@/diagnostics/logger'
import { runMigrations } from '@/storage/migrations'
import { createSqlJsPort, type SqlJsPort } from '@/storage/sqlJsPort'

export const DB_FILE = 'punchcraft.db'
/** Where a saved database that would not open is kept. One slot. */
export const UNREADABLE_FILE = 'punchcraft.db.unreadable'
/** How long after a write the file is saved. Writes inside it share one save. */
export const SAVE_DELAY_MS = 750
/** How long after a failed save the next one is tried. */
export const SAVE_RETRY_MS = 10_000

let port: SqlJsPort | null = null
let preparing: Promise<void> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving = false
/** `port.writeCount()` as of the last export that reached the disk. */
let savedCount = 0
/** Set when saving would destroy a file that could not be copied aside. */
let savingOff = false

async function writeFile(name: string, bytes: Uint8Array): Promise<void> {
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  // sql.js hands back a copy on an ordinary buffer; the DOM types only
  // cannot see that it is not a shared one.
  await writable.write(bytes as Uint8Array<ArrayBuffer>)
  await writable.close()
}

async function loadSavedBytes(): Promise<Uint8Array | null> {
  const root = await navigator.storage.getDirectory()
  let handle: FileSystemFileHandle
  try {
    handle = await root.getFileHandle(DB_FILE)
  } catch {
    return null // first run: nothing saved yet
  }
  const file = await handle.getFile()
  return file.size === 0 ? null : new Uint8Array(await file.arrayBuffer())
}

const unsaved = (): boolean => port !== null && port.writeCount() !== savedCount

function scheduleSave(delayMs: number = SAVE_DELAY_MS): void {
  if (saveTimer !== null) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void save()
  }, delayMs)
}

async function save(): Promise<void> {
  const db = port
  if (!db || saving || savingOff || !unsaved()) return
  const count = db.writeCount()
  const bytes = db.exportBytes()
  // Mid-transaction. Nothing in this app holds one across a turn of the event
  // loop, so this is not expected — and needs no retry of its own: the
  // statement that ends the transaction is a write, and schedules the save.
  if (bytes === null) return
  saving = true
  let failed = false
  try {
    await writeFile(DB_FILE, bytes)
    if (port === db) savedCount = count
  } catch (err) {
    failed = true
    logger.error('storage.web.saveFailed', 'the database could not be saved in this browser', {
      error: safe(String(err)),
    })
  } finally {
    saving = false
    // A write that landed while this save was in flight still needs one, and
    // so does everything in a save that failed.
    if (port === db && unsaved()) scheduleSave(failed ? SAVE_RETRY_MS : SAVE_DELAY_MS)
  }
}

/** Open what was saved, or — when that will not open — an empty database. */
async function openSaved(SQL: SqlJsStatic, bytes: Uint8Array | null): Promise<SqlJsPort> {
  const open = (data: Uint8Array | null): SqlJsPort => {
    const opened = createSqlJsPort(new SQL.Database(data))
    runMigrations(opened as unknown as SQLiteDatabase)
    return opened
  }
  if (bytes === null) return open(null)
  try {
    return open(bytes)
  } catch (err) {
    logger.error('storage.web.openFailed', 'the saved database would not open; starting empty', {
      error: safe(String(err)),
      bytes: safe(bytes.length),
    })
    try {
      await writeFile(UNREADABLE_FILE, bytes)
    } catch (asideErr) {
      savingOff = true
      logger.error(
        'storage.web.setAsideFailed',
        'the unreadable database could not be copied aside; nothing will be saved this visit',
        { error: safe(String(asideErr)) },
      )
    }
    return open(null)
  }
}

/**
 * Load the engine and the saved database. Idempotent; resolves once storage
 * can be used. Rejects only if the engine itself cannot load — there is no
 * database to offer then, and the app cannot run without one.
 */
export function prepareStorage(): Promise<void> {
  preparing ??= (async () => {
    const startedAt = performance.now()
    const SQL = await initSqlJs({ locateFile: () => wasmUrl })
    let bytes: Uint8Array | null = null
    try {
      bytes = await loadSavedBytes()
    } catch (err) {
      // No private file system here (an old browser, a locked-down profile).
      // The app runs; nothing it stores outlives the tab.
      savingOff = true
      logger.error('storage.web.loadFailed', 'this browser has no storage the app can use', {
        error: safe(String(err)),
      })
    }
    const opened = await openSaved(SQL, bytes)
    // Saved once after every load: a fresh database never has been, and the
    // migration runner cannot say whether it just changed a loaded one. A
    // spare save of a small file is cheaper than working that out.
    savedCount = -1
    opened.onWrite(() => scheduleSave())
    port = opened
    scheduleSave()
    // The page going away is the last chance to save what the timer has not.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void save()
    })
    window.addEventListener('pagehide', () => void save())
    logger.info('storage.open', 'punchcraft.db opened', {
      name: safe(DB_FILE),
      engine: safe('sql.js'),
      restoredBytes: safe(bytes?.length ?? 0),
      ms: safe(Math.round(performance.now() - startedAt)),
    })
  })()
  return preparing
}

export function isStorageReady(): boolean {
  return port !== null
}

export function openDatabase(): SQLiteDatabase {
  if (!port) {
    throw new Error('storage is not ready: prepareStorage() has not finished (see database.web.ts)')
  }
  return port as unknown as SQLiteDatabase
}

/** Reset the module to "never prepared". Intended for tests. */
export function __resetDatabaseForTests(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = null
  saving = false
  savedCount = 0
  savingOff = false
  port = null
  preparing = null
}
