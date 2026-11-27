/**
 * The app database in a browser — the PC version's `database.ts`.
 *
 * Metro picks this file over `database.ts` for the web build, so nothing
 * that imports `@storage/database` knows the difference: `openDatabase()`
 * still hands back a synchronous database with the migrations applied. What
 * is different is underneath (`sqlJsPort.ts` says why it is not expo-sqlite)
 * and around it:
 *
 * - **It has to be prepared first.** The engine is WebAssembly and the saved
 *   database is in IndexedDB; both load asynchronously, and every storage
 *   call in the app is synchronous. `prepareStorage()` does the loading
 *   once, and the root layout waits for it before mounting anything that
 *   could open the database.
 * - **It lives in memory and is saved as a whole.** After a write the
 *   database is exported and put in IndexedDB (`idbByteStore.web.ts` says
 *   why there), `SAVE_DELAY_MS` later, and at once when the tab is hidden.
 *   Closing or reloading the tab inside that delay loses those writes: a
 *   save started as the page goes away does not finish. It never damages
 *   what was saved before — an IndexedDB transaction commits whole or not
 *   at all. A save that fails is tried again, more slowly.
 * - **One tab at a time.** Each tab would hold its own copy and save it over
 *   the other's. The first tab takes a lock for its lifetime; a second is
 *   told so (`StorageNotice`) and does not start.
 * - **A saved database that has gone missing is said out loud.** The last
 *   save leaves a note in `localStorage`. A load that finds the note and no
 *   database logs an error rather than passing for a first run. This is not
 *   hypothetical: when the database was a file in the private file system,
 *   the Claude desktop app's browser pane emptied it twice (findings doc
 *   N-10).
 * - **If the saved database will not open, the app still runs** — on an
 *   empty one, with an error in the log. The bytes that would not open are
 *   copied aside first (`UNREADABLE_FILE`); if even that fails, nothing is
 *   saved for the rest of the visit, so they are never overwritten unseen.
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
import { openIdbByteStore, type ByteStore } from '@/storage/idbByteStore.web'
import { createSqlJsPort, type SqlJsPort } from '@/storage/sqlJsPort'
import { StorageNotice } from '@/storage/storageNotice'

/** The key the database is kept under (`idbByteStore.web.ts`). */
export const DB_FILE = 'punchcraft.db'
/** The Web Lock one tab holds for as long as it has the database open. */
export const LOCK_NAME = 'punchcraft.db'
/**
 * How long a tab waits for that lock before deciding another tab has it. A
 * reload's old page lets go as it unloads; this is the slack for that.
 */
export const CLAIM_WAIT_MS = 1_500
/** `localStorage` key: what the last successful save was, `{ bytes, at }`. */
export const SAVED_MARKER_KEY = 'punchcraft.db.saved'
export const SECOND_TAB_NOTICE =
  'punchCraft is already open in another tab of this browser. Close this tab — or close the other one, then reload this one.'
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

/** Opened on first use, so a browser with no IndexedDB fails where it is handled. */
let store: ByteStore | null = null
const byteStore = (): ByteStore => (store ??= openIdbByteStore())

/** What the last successful save was, by this browser's own account. */
function readSavedMarker(): { bytes: number; at: string } | null {
  try {
    const raw = window.localStorage.getItem(SAVED_MARKER_KEY)
    if (raw === null) return null
    const { bytes, at } = JSON.parse(raw) as { bytes?: unknown; at?: unknown }
    return typeof bytes === 'number' && typeof at === 'string' ? { bytes, at } : null
  } catch {
    return null
  }
}

function writeSavedMarker(bytes: number): void {
  try {
    // Wall time, for a person reading the log — never used to order anything.
    const marker = { bytes, at: new Date().toISOString() }
    window.localStorage.setItem(SAVED_MARKER_KEY, JSON.stringify(marker))
  } catch {
    // The note is a courtesy to the next load; the save itself succeeded.
  }
}

/**
 * Take the database for this tab. Resolves false when another tab has it.
 *
 * The lock is held for as long as the callback's promise is pending, which
 * is for ever: the browser releases it when the tab goes away. A browser
 * without Web Locks is taken at its word that there is one tab.
 */
function claimDatabase(): Promise<boolean> {
  const locks = navigator.locks as typeof navigator.locks | undefined
  if (!locks) return Promise.resolve(true)
  return new Promise((resolve) => {
    const giveUp = new AbortController()
    const timer = setTimeout(() => giveUp.abort(), CLAIM_WAIT_MS)
    locks
      .request(LOCK_NAME, { signal: giveUp.signal }, () => {
        clearTimeout(timer)
        resolve(true)
        return new Promise<void>(() => undefined)
      })
      .catch(() => resolve(false))
  })
}

/** Ask the browser not to evict the database when the disk runs short. */
async function askToKeepStorage(): Promise<void> {
  try {
    const granted = (await navigator.storage.persist?.()) ?? false
    logger.info('storage.web.persistence', 'asked the browser to keep the database', {
      granted: safe(granted),
    })
  } catch {
    // Not every browser has the question; none of them needs the answer.
  }
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
    await byteStore().put(DB_FILE, bytes)
    writeSavedMarker(bytes.length)
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
      await byteStore().put(UNREADABLE_FILE, bytes)
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
 * can be used. Rejects in two cases, and the app does not start in either:
 * another tab has the database (a `StorageNotice`, worded for the athlete),
 * or the engine itself cannot load.
 */
export function prepareStorage(): Promise<void> {
  preparing ??= (async () => {
    const startedAt = performance.now()
    if (!(await claimDatabase())) throw new StorageNotice(SECOND_TAB_NOTICE)
    const SQL = await initSqlJs({ locateFile: () => wasmUrl })
    let bytes: Uint8Array | null = null
    try {
      bytes = await byteStore().get(DB_FILE)
    } catch (err) {
      // No IndexedDB here (a locked-down profile), or one that would not
      // give the database up. The app runs, and saves nothing: whatever is
      // stored is left exactly as it is. Only a key that was never written
      // reads as "nothing saved" — see `idbByteStore.web.ts`.
      savingOff = true
      logger.error(
        'storage.web.loadFailed',
        'the browser storage could not be read; nothing will be saved this visit',
        { error: safe(String(err)) },
      )
    }
    if (bytes === null && !savingOff) {
      const last = readSavedMarker()
      if (last) {
        logger.error(
          'storage.web.savedFileMissing',
          'the database this browser saved is no longer there; starting empty',
          { lastSavedBytes: safe(last.bytes), lastSavedAt: safe(last.at) },
        )
      }
    }
    void askToKeepStorage()
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
  store = null
}
