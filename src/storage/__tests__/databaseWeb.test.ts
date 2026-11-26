/**
 * The browser's database module (`database.web.ts`), with the browser stood
 * in for: the real sql.js engine (its Node build), an in-memory private file
 * system, and fake timers for the save delay.
 *
 * What this cannot show is the real thing — WebAssembly loading from the
 * served URL, and the browser's own file system. `npm run pc:smoke` does.
 */
import { replaceSinks, type LogRecord } from '@diagnostics/logger'
import { SettingsRepository } from '@/storage/repositories/SettingsRepository'
import { SETTINGS_KEYS } from '@/storage/migrations/006_app_settings'
import {
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

/** The origin-private file system, as far as `database.web.ts` uses it. */
class FakeFiles {
  readonly files = new Map<string, Uint8Array>()
  /** Names written, in order — one entry per completed write. */
  readonly writes: string[] = []
  failWritesTo: string | null = null
  available = true

  getDirectory = async () => {
    if (!this.available) throw new Error('SecurityError: storage is not available')
    return {
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        if (!this.files.has(name) && !opts?.create) throw new Error('NotFoundError')
        return {
          getFile: async () => {
            const bytes = this.files.get(name) ?? new Uint8Array()
            return { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }
          },
          createWritable: async () => {
            if (this.failWritesTo === name) throw new Error('QuotaExceededError')
            let pending = new Uint8Array()
            return {
              write: async (bytes: Uint8Array) => {
                pending = bytes.slice()
              },
              close: async () => {
                this.files.set(name, pending)
                this.writes.push(name)
              },
            }
          },
        }
      },
    }
  }
}

let files: FakeFiles
let records: LogRecord[]
let listeners: Record<string, Array<() => void>>
let visibility: 'visible' | 'hidden'

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
  records = []
  listeners = {}
  visibility = 'visible'
  replaceSinks([{ write: (r) => records.push(r) }])
  const listen = (type: string, fn: () => void): void => {
    ;(listeners[type] ??= []).push(fn)
  }
  define('navigator', { storage: { getDirectory: files.getDirectory } })
  define('document', {
    addEventListener: listen,
    get visibilityState() {
      return visibility
    },
  })
  define('window', { addEventListener: listen })
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

  it('happens at once when the page is hidden or closed', async () => {
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

describe('a saved file that will not open', () => {
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

describe('a browser with no private file system', () => {
  it('still runs, says so once, and does not keep trying to save', async () => {
    files.available = false
    await prepareStorage()
    expect(isStorageReady()).toBe(true)
    setting().write(SETTINGS_KEYS.qa, { enabled: true })
    await afterDelay(SAVE_RETRY_MS * 3)
    expect(qaEnabled()).toBe(true)
    expect(codes().filter((c) => c.startsWith('storage.web.'))).toEqual(['storage.web.loadFailed'])
  })
})
