/**
 * The browser's database module (`database.web.ts`), with the browser stood
 * in for: the real sql.js engine (its Node build), a map where IndexedDB
 * would be, and fake timers for the save delay.
 *
 * What this cannot show is the real thing — WebAssembly loading from the
 * served URL, and the browser's own IndexedDB. `npm run pc:smoke` does.
 */
import { replaceSinks, type LogRecord } from '@diagnostics/logger'
import { SettingsRepository } from '@/storage/repositories/SettingsRepository'
import { SETTINGS_KEYS } from '@/storage/migrations/006_app_settings'
import { StorageNotice } from '@/storage/storageNotice'
import {
  CLAIM_WAIT_MS,
  SAVED_MARKER_KEY,
  SECOND_TAB_NOTICE,
  DB_FILE,
  SAVE_DELAY_MS,
  SAVE_RETRY_MS,
  UNREADABLE_FILE,
  __resetDatabaseForTests,
  isStorageReady,
  openDatabase,
  prepareStorage,
} from '@/storage/database.web'

jest.mock('sql.js/dist/sql-wasm-browser.js', () => {
  // The Node build finds its own .wasm; the browser's `locateFile` is dropped.
  const init = jest.requireActual('sql.js')
  return { __esModule: true, default: () => init() }
})
jest.mock(
  'sql.js/dist/sql-wasm-browser.wasm',
  () => ({ __esModule: true, default: 'sql-wasm.wasm' }),
  { virtual: true },
)

/**
 * The byte store `database.web.ts` saves into — IndexedDB in a browser
 * (`idbByteStore.web.ts`, which has its own tests), a map here.
 */
class FakeFiles {
  readonly files = new Map<string, Uint8Array>()
  /** Keys written, in order — one entry per committed write. */
  readonly writes: string[] = []
  failWritesTo: string | null = null
  available = true
  /** A key that is there and will not be handed over. */
  refuse: string | null = null

  get = async (key: string): Promise<Uint8Array | null> => {
    if (!this.available) throw new Error('SecurityError: storage is not available')
    if (this.refuse === key) throw named('InvalidStateError')
    return this.files.get(key)?.slice() ?? null
  }

  put = async (key: string, bytes: Uint8Array): Promise<void> => {
    if (!this.available) throw new Error('SecurityError: storage is not available')
    if (this.failWritesTo === key) throw new Error('QuotaExceededError')
    this.files.set(key, bytes.slice())
    this.writes.push(key)
  }
}

let mockFiles: FakeFiles
jest.mock('@/storage/idbByteStore.web', () => ({
  openIdbByteStore: () => mockFiles,
}))

/** The Web Locks manager, as far as one named lock goes. */
class FakeLocks {
  heldElsewhere = false
  /** Whether this page's callback is still holding the lock. */
  held = false

  request = (
    _name: string,
    options: { signal: { addEventListener(type: 'abort', listener: () => void): void } },
    callback: () => Promise<void>,
  ): Promise<void> =>
    new Promise((_resolve, reject) => {
      if (this.heldElsewhere) {
        // Queued behind the other tab until the caller gives up.
        options.signal.addEventListener('abort', () => reject(named('AbortError')))
        return
      }
      this.held = true
      void callback().then(() => {
        this.held = false
      })
    })
}

let files: FakeFiles
let locks: FakeLocks
let local: Map<string, string>
let records: LogRecord[]
let listeners: Record<string, Array<() => void>>
let visibility: 'visible' | 'hidden'

function named(name: string): Error {
  return Object.assign(new Error(name), { name })
}
const define = (name: string, value: unknown): void => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
const codes = (): string[] => records.map((r) => r.code)
/** Let every pending promise in a save settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}
const afterDelay = async (ms: number): Promise<void> => {
  jest.advanceTimersByTime(ms)
  await settle()
}
const savesOf = (name: string): number => files.writes.filter((n) => n === name).length
const setting = () => new SettingsRepository(openDatabase())
/** The stored QA flag: undefined when there is no row. */
const qaEnabled = (): unknown =>
  setting().readChecked(SETTINGS_KEYS.qa, (stored) => ({ enabled: stored.enabled })).value.enabled
/** A fresh page load over whatever the last one left on disk. */
const reload = async (): Promise<void> => {
  __resetDatabaseForTests()
  await prepareStorage()
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['performance'] })
  __resetDatabaseForTests()
  files = new FakeFiles()
  mockFiles = files
  locks = new FakeLocks()
  local = new Map()
  records = []
  listeners = {}
  visibility = 'visible'
  replaceSinks([{ write: (r) => records.push(r) }])
  const listen = (type: string, fn: () => void): void => {
    ;(listeners[type] ??= []).push(fn)
  }
  define('navigator', {
    storage: { persist: async () => true },
    locks,
  })
  define('document', {
    addEventListener: listen,
    get visibilityState() {
      return visibility
    },
  })
  define('window', {
    addEventListener: listen,
    localStorage: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => void local.set(key, value),
    },
  })
})

afterEach(() => {
  jest.useRealTimers()
  replaceSinks([])
})

describe('before it is prepared', () => {
  it('is not ready, and opening the database says why', () => {
    expect(isStorageReady()).toBe(false)
    expect(() => openDatabase()).toThrow(/prepareStorage/)
  })
})

describe('preparing', () => {
  it('opens a migrated database, once, however often it is asked', async () => {
    const first = prepareStorage()
    expect(prepareStorage()).toBe(first)
    await first
    expect(isStorageReady()).toBe(true)
    expect(qaEnabled()).toBeUndefined()
    expect(codes().filter((c) => c === 'storage.open')).toHaveLength(1)
  })
})

describe('saving', () => {
  it('waits out the delay, and several writes share one save', async () => {
    await prepareStorage()
    await afterDelay(SAVE_DELAY_MS) // the save every load owes
    expect(savesOf(DB_FILE)).toBe(1)

    setting().write(SETTINGS_KEYS.qa, { enabled: true })
    setting().write(SETTINGS_KEYS.qa, { enabled: false })
    await afterDelay(SAVE_DELAY_MS - 1)
    expect(savesOf(DB_FILE)).toBe(1)
    await afterDelay(1)
    expect(savesOf(DB_FILE)).toBe(2)
  })

  it('does not save again when nothing was written', async () => {
    await prepareStorage()
    await afterDelay(SAVE_DELAY_MS)
    qaEnabled()
    await afterDelay(SAVE_DELAY_MS * 10)
    expect(savesOf(DB_FILE)).toBe(1)
  })

  it('is what the next page load reads', async () => {
    await prepareStorage()
    setting().write(SETTINGS_KEYS.qa, { enabled: true })
    await afterDelay(SAVE_DELAY_MS)

    await reload()
    expect(qaEnabled()).toBe(true)
  })

  it('is started at once when the page is hidden or going away', async () => {
    await prepareStorage()
    setting().write(SETTINGS_KEYS.qa, { enabled: true })
    visibility = 'hidden'
    for (const fn of listeners.visibilitychange ?? []) fn()
    await settle()
    expect(savesOf(DB_FILE)).toBe(1)

    setting().write(SETTINGS_KEYS.qa, { enabled: false })
    for (const fn of listeners.pagehide ?? []) fn()
    await settle()
    expect(savesOf(DB_FILE)).toBe(2)
  })

  it('does not save on a visibility change back to visible', async () => {
    await prepareStorage()
    for (const fn of listeners.visibilitychange ?? []) fn()
    await settle()
    expect(savesOf(DB_FILE)).toBe(0)
  })

  it('waits for a transaction to end, then saves what it committed', async () => {
    await prepareStorage()
    await afterDelay(SAVE_DELAY_MS)
    const db = openDatabase()
    db.execSync('BEGIN')
    setting().write(SETTINGS_KEYS.qa, { enabled: true })
    await afterDelay(SAVE_DELAY_MS)
    expect(savesOf(DB_FILE)).toBe(1)

    db.execSync('COMMIT')
    await afterDelay(SAVE_DELAY_MS)
    expect(savesOf(DB_FILE)).toBe(2)
    await reload()
    expect(qaEnabled()).toBe(true)
  })

  it('tries again, more slowly, after a save that failed — and loses nothing', async () => {
    await prepareStorage()
    await afterDelay(SAVE_DELAY_MS)
    files.failWritesTo = DB_FILE
    setting().write(SETTINGS_KEYS.qa, { enabled: true })
    await afterDelay(SAVE_DELAY_MS)
    expect(codes()).toContain('storage.web.saveFailed')
    expect(savesOf(DB_FILE)).toBe(1)

    files.failWritesTo = null
    await afterDelay(SAVE_RETRY_MS - 1)
    expect(savesOf(DB_FILE)).toBe(1)
    await afterDelay(1)
    expect(savesOf(DB_FILE)).toBe(2)
    await reload()
    expect(qaEnabled()).toBe(true)
  })
})

describe('a saved database that will not open', () => {
  const garbage = new Uint8Array(4096).fill(0x5a)

  it('is copied aside, and the app starts on an empty database it can save', async () => {
    files.files.set(DB_FILE, garbage)
    await prepareStorage()
    expect(isStorageReady()).toBe(true)
    expect(codes()).toContain('storage.web.openFailed')
    expect(files.files.get(UNREADABLE_FILE)).toEqual(garbage)

    setting().write(SETTINGS_KEYS.qa, { enabled: true })
    await afterDelay(SAVE_DELAY_MS)
    await reload()
    expect(qaEnabled()).toBe(true)
  })

  it('is never overwritten when it could not be copied aside', async () => {
    files.files.set(DB_FILE, garbage)
    files.failWritesTo = UNREADABLE_FILE
    await prepareStorage()
    expect(codes()).toContain('storage.web.setAsideFailed')

    setting().write(SETTINGS_KEYS.qa, { enabled: true })
    await afterDelay(SAVE_RETRY_MS * 2)
    for (const fn of listeners.pagehide ?? []) fn()
    await settle()
    expect(files.files.get(DB_FILE)).toEqual(garbage)
    expect(savesOf(DB_FILE)).toBe(0)
  })
})

describe('a browser whose storage cannot be used', () => {
  it('still runs, says so once, and does not keep trying to save', async () => {
    files.available = false
    await prepareStorage()
    expect(isStorageReady()).toBe(true)
    setting().write(SETTINGS_KEYS.qa, { enabled: true })
    await afterDelay(SAVE_RETRY_MS * 3)
    expect(qaEnabled()).toBe(true)
    expect(records.filter((r) => r.level === 'error').map((r) => r.code)).toEqual([
      'storage.web.loadFailed',
    ])
  })
})

describe('a saved database that is there and will not be read', () => {
  it('is not mistaken for a first run — and is never saved over', async () => {
    const saved = new Uint8Array([1, 2, 3])
    files.files.set(DB_FILE, saved)
    files.refuse = DB_FILE
    await prepareStorage()
    expect(isStorageReady()).toBe(true)
    expect(codes()).toContain('storage.web.loadFailed')

    files.refuse = null
    setting().write(SETTINGS_KEYS.qa, { enabled: true })
    await afterDelay(SAVE_RETRY_MS * 2)
    expect(files.files.get(DB_FILE)).toBe(saved)
  })
})

describe('one tab at a time', () => {
  it('takes the lock, and keeps it for the life of the tab', async () => {
    await prepareStorage()
    expect(locks.held).toBe(true)
    await afterDelay(60_000)
    expect(locks.held).toBe(true)
  })

  it('does not start in a second tab, and says why in words for the athlete', async () => {
    locks.heldElsewhere = true
    const preparing = prepareStorage()
    const outcome = preparing.then(
      () => 'started',
      (err: unknown) => err,
    )
    await afterDelay(CLAIM_WAIT_MS)
    const err = await outcome
    expect(err).toBeInstanceOf(StorageNotice)
    expect((err as Error).message).toBe(SECOND_TAB_NOTICE)
    expect(isStorageReady()).toBe(false)
    // It never touched the other tab's file.
    expect(files.writes).toEqual([])
  })

  it('waits for a reload’s old page to let go, rather than giving up at once', async () => {
    locks.heldElsewhere = true
    const preparing = prepareStorage()
    await afterDelay(CLAIM_WAIT_MS - 1)
    expect(isStorageReady()).toBe(false)
    await afterDelay(1)
    await expect(preparing).rejects.toBeInstanceOf(StorageNotice)
  })

  it('takes a browser without Web Locks at its word', async () => {
    define('navigator', { storage: {} })
    await prepareStorage()
    expect(isStorageReady()).toBe(true)
  })
})

describe('a saved database that has gone missing', () => {
  it('is said out loud: the last save left a note, and the file is not there', async () => {
    await prepareStorage()
    await afterDelay(SAVE_DELAY_MS)
    const note = JSON.parse(local.get(SAVED_MARKER_KEY) ?? '{}') as { bytes: number; at: string }
    expect(note.bytes).toBe(files.files.get(DB_FILE)?.length)

    files.files.delete(DB_FILE) // the browser dropped it; the note survived
    await reload()
    const missing = records.find((r) => r.code === 'storage.web.savedFileMissing')
    expect(missing?.level).toBe('error')
    expect(missing?.fields.lastSavedBytes?.value).toBe(note.bytes)
    // …and the app still starts, and saves again.
    await afterDelay(SAVE_DELAY_MS)
    expect(files.files.has(DB_FILE)).toBe(true)
  })

  it('is not cried over on a first run, or when the file is where it was left', async () => {
    await prepareStorage()
    await afterDelay(SAVE_DELAY_MS)
    await reload()
    expect(codes()).not.toContain('storage.web.savedFileMissing')
  })

  it('survives a note it cannot read', async () => {
    local.set(SAVED_MARKER_KEY, 'not json')
    await prepareStorage()
    expect(codes()).not.toContain('storage.web.savedFileMissing')
    expect(isStorageReady()).toBe(true)
  })
})

describe('asking the browser to keep the database', () => {
  it('asks, and logs the answer', async () => {
    await prepareStorage()
    await settle()
    const asked = records.find((r) => r.code === 'storage.web.persistence')
    expect(asked?.fields.granted?.value).toBe(true)
  })
})
