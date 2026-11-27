/**
 * Named blobs of bytes in IndexedDB — where the PC version keeps its
 * database.
 *
 * It used to be a file in the browser's private file system. That is the
 * natural home for a file, and Chrome keeps it faithfully — but the Claude
 * desktop app's built-in browser pane empties that file system for a page
 * left idle about ten minutes, and leaves IndexedDB alone (findings doc
 * N-10). Measured both ways: a canary in each on 2026-11-26, and then this
 * store itself on 2026-11-27 — thirteen idle minutes took a canary file and
 * left the database, and a reload restored it. IndexedDB is also the one of
 * the two that every browser has had for a decade.
 *
 * Two promises this makes, both tested:
 *
 * - **A write is saved when its transaction COMMITS**, not when the request
 *   succeeds. A request can succeed inside a transaction that then aborts
 *   (quota, a closing tab); resolving early would report a save that never
 *   reached the disk. The transaction asks for strict durability, so
 *   "committed" means flushed, not sitting in an OS buffer.
 * - **A key that was never written reads as `null`**, and nothing else does.
 *   Every failure rejects. `database.web.ts` relies on the difference: null
 *   is "nothing saved yet", a rejection is "storage is misbehaving — do not
 *   save over whatever is there".
 */

export interface ByteStore {
  /** The bytes saved under `key`, or null when nothing ever was. */
  get(key: string): Promise<Uint8Array | null>
  /** Resolves once the write is committed. */
  put(key: string, bytes: Uint8Array): Promise<void>
}

export const IDB_NAME = 'punchcraft'
export const IDB_STORE = 'files'

/** What IndexedDB may hand back for bytes that were stored as bytes. */
function asBytes(value: unknown): Uint8Array | null {
  if (value === undefined || value === null) return null
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new Error('the saved database is not bytes')
}

export function openIdbByteStore(factory: IDBFactory = indexedDB): ByteStore {
  // One connection for the life of the page, opened on first use.
  let opening: Promise<IDBDatabase> | null = null
  const database = (): Promise<IDBDatabase> =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(IDB_NAME, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(IDB_STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB would not open'))
      request.onblocked = () => reject(new Error('IndexedDB is held open by another tab'))
    }).catch((err: unknown) => {
      // Not cached: the next call tries again rather than failing for good.
      opening = null
      throw err
    }))

  return {
    async get(key) {
      const db = await database()
      return new Promise<Uint8Array | null>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly')
        const request = tx.objectStore(IDB_STORE).get(key)
        request.onsuccess = () => {
          try {
            resolve(asBytes(request.result))
          } catch (err) {
            reject(err)
          }
        }
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB read was aborted'))
      })
    },

    async put(key, bytes) {
      const db = await database()
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite', { durability: 'strict' })
        tx.objectStore(IDB_STORE).put(bytes, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write was aborted'))
      })
    },
  }
}
