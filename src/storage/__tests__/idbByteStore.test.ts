/**
 * The IndexedDB byte store, against a stand-in IndexedDB whose events the
 * test fires by hand — because the two things worth pinning are about WHEN:
 * a write is saved at commit, not at request success, and a missing key is
 * the only thing that reads as null.
 *
 * The real IndexedDB is exercised by `npm run pc:smoke`, which reads the
 * database back out of it with its own code.
 */
import { IDB_NAME, IDB_STORE, openIdbByteStore } from '@/storage/idbByteStore.web'

type Handler = (() => void) | null

/** One transaction the test can commit or abort. */
class FakeTx {
  oncomplete: Handler = null
  onerror: Handler = null
  onabort: Handler = null
  error: Error | null = null
  readonly requests: Array<{ result: unknown; onsuccess: Handler; onerror: Handler }> = []
  constructor(
    readonly mode: string,
    readonly options: { durability?: string } | undefined,
    private readonly data: Map<string, unknown>,
    private readonly pending: Map<string, unknown>,
  ) {}

  objectStore(name: string) {
    if (name !== IDB_STORE) throw new Error(`no such store: ${name}`)
    return {
      get: (key: string) => {
        const request = { result: this.data.get(key), onsuccess: null as Handler, onerror: null }
        this.requests.push(request)
        return request
      },
      put: (value: unknown, key: string) => {
        this.pending.set(key, value)
        const request = { result: key, onsuccess: null as Handler, onerror: null }
        this.requests.push(request)
        return request
      },
    }
  }

  /** Requests succeed; nothing is durable yet. */
  succeedRequests(): void {
    for (const request of this.requests) request.onsuccess?.()
  }
  commit(): void {
    for (const [key, value] of this.pending) this.data.set(key, value)
    this.pending.clear()
    this.oncomplete?.()
  }
  abort(error: Error): void {
    this.pending.clear()
    this.error = error
    this.onabort?.()
  }
}

class FakeIdb {
  readonly data = new Map<string, unknown>()
  readonly transactions: FakeTx[] = []
  readonly opened: Array<{ name: string; version: number }> = []
  stores = new Set<string>()
  failOpen: Error | null = null

  factory = {
    open: (name: string, version: number) => {
      this.opened.push({ name, version })
      const db = {
        createObjectStore: (store: string) => void this.stores.add(store),
        transaction: (store: string, mode: string, options?: { durability?: string }) => {
          const tx = new FakeTx(mode, options, this.data, new Map())
          this.transactions.push(tx)
          void store
          return tx
        },
      }
      const request = {
        result: db,
        error: this.failOpen,
        onupgradeneeded: null as Handler,
        onsuccess: null as Handler,
        onerror: null as Handler,
        onblocked: null as Handler,
      }
      void Promise.resolve().then(() => {
        if (this.failOpen) return request.onerror?.()
        if (!this.stores.has(IDB_STORE)) request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  } as unknown as Parameters<typeof openIdbByteStore>[0]

  get lastTx(): FakeTx {
    return this.transactions[this.transactions.length - 1] as FakeTx
  }
}

/** Let the open and the promise chain around it settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}
const state = async (p: Promise<unknown>): Promise<string> =>
  Promise.race([
    p.then(
      () => 'resolved',
      () => 'rejected',
    ),
    settle().then(() => 'pending'),
  ])

let idb: FakeIdb
beforeEach(() => {
  idb = new FakeIdb()
})

describe('opening', () => {
  it('opens one database, creates the store on first use, and reuses the connection', async () => {
    const store = openIdbByteStore(idb.factory)
    const first = store.get('a')
    await settle()
    idb.lastTx.succeedRequests()
    await first
    const second = store.get('b')
    await settle()
    idb.lastTx.succeedRequests()
    await second

    expect(idb.opened).toEqual([{ name: IDB_NAME, version: 1 }])
    expect([...idb.stores]).toEqual([IDB_STORE])
  })

  it('rejects when IndexedDB will not open — and tries again next time', async () => {
    idb.failOpen = new Error('SecurityError')
    const store = openIdbByteStore(idb.factory)
    await expect(store.get('a')).rejects.toThrow('SecurityError')

    idb.failOpen = null
    const retry = store.get('a')
    await settle()
    idb.lastTx.succeedRequests()
    await expect(retry).resolves.toBeNull()
    expect(idb.opened).toHaveLength(2)
  })
})

describe('reading', () => {
  it('reads a key that was never written as null', async () => {
    const read = openIdbByteStore(idb.factory).get('punchcraft.db')
    await settle()
    idb.lastTx.succeedRequests()
    await expect(read).resolves.toBeNull()
    expect(idb.lastTx.mode).toBe('readonly')
  })

  it('hands back the bytes, whether they come back as a view or a buffer', async () => {
    const store = openIdbByteStore(idb.factory)
    idb.data.set('view', new Uint8Array([1, 2, 3]))
    idb.data.set('buffer', new Uint8Array([4, 5]).buffer)

    const view = store.get('view')
    await settle()
    idb.lastTx.succeedRequests()
    expect(Array.from((await view) as Uint8Array)).toEqual([1, 2, 3])

    const buffer = store.get('buffer')
    await settle()
    idb.lastTx.succeedRequests()
    expect(Array.from((await buffer) as Uint8Array)).toEqual([4, 5])
  })

  it('rejects, rather than reading as empty, when what is stored is not bytes', async () => {
    idb.data.set('punchcraft.db', 'a string someone put here')
    const read = openIdbByteStore(idb.factory).get('punchcraft.db')
    await settle()
    idb.lastTx.succeedRequests()
    await expect(read).rejects.toThrow('not bytes')
  })

  it('rejects when the read is aborted', async () => {
    const read = openIdbByteStore(idb.factory).get('punchcraft.db')
    await settle()
    idb.lastTx.abort(new Error('InvalidStateError'))
    await expect(read).rejects.toThrow('InvalidStateError')
  })
})

describe('writing', () => {
  it('is saved when the transaction commits — not when the request succeeds', async () => {
    const write = openIdbByteStore(idb.factory).put('punchcraft.db', new Uint8Array([9]))
    await settle()
    idb.lastTx.succeedRequests()
    expect(await state(write)).toBe('pending')
    expect(idb.data.has('punchcraft.db')).toBe(false)

    idb.lastTx.commit()
    await expect(write).resolves.toBeUndefined()
    expect(Array.from(idb.data.get('punchcraft.db') as Uint8Array)).toEqual([9])
  })

  it('asks for a write that is flushed, not merely buffered', async () => {
    const write = openIdbByteStore(idb.factory).put('k', new Uint8Array([1]))
    await settle()
    expect(idb.lastTx.mode).toBe('readwrite')
    expect(idb.lastTx.options).toEqual({ durability: 'strict' })
    idb.lastTx.commit()
    await write
  })

  it('rejects when the transaction aborts after its request succeeded, and saves nothing', async () => {
    idb.data.set('punchcraft.db', new Uint8Array([1]))
    const write = openIdbByteStore(idb.factory).put('punchcraft.db', new Uint8Array([2]))
    await settle()
    idb.lastTx.succeedRequests()
    idb.lastTx.abort(new Error('QuotaExceededError'))

    await expect(write).rejects.toThrow('QuotaExceededError')
    // What was saved before is still what is saved.
    expect(Array.from(idb.data.get('punchcraft.db') as Uint8Array)).toEqual([1])
  })
})
