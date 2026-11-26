/**
 * Whether storage may be used yet — what the root layout waits on.
 *
 * On the tablet the database opens synchronously, so this is `ready` on the
 * first render and nothing is ever awaited: the app mounts exactly as it did
 * before this existed. In a browser the engine and the saved file load
 * asynchronously (`database.web.ts`), and everything under the root layout
 * reads storage synchronously, so none of it may mount until they have.
 *
 * `failed` carries a sentence for the screen. A `StorageNotice` is already
 * worded for the athlete ("already open in another tab"); anything else is a
 * fault, said plainly, with the details in the log.
 */
import { useEffect, useState } from 'react'

import { logger, safe } from '@diagnostics/logger'
import { isStorageReady, prepareStorage } from '@storage/database'
import { StorageNotice } from '@storage/storageNotice'

export type StorageStatus =
  { state: 'loading' } | { state: 'ready' } | { state: 'failed'; reason: string }

export const STORAGE_FAULT =
  'punchCraft could not start: its database did not load. The browser console has the reason.'

const READY: StorageStatus = { state: 'ready' }
const LOADING: StorageStatus = { state: 'loading' }

export function useStorageReady(): StorageStatus {
  const [status, setStatus] = useState<StorageStatus>(() => (isStorageReady() ? READY : LOADING))
  useEffect(() => {
    if (status.state !== 'loading') return
    let cancelled = false
    prepareStorage().then(
      () => {
        if (!cancelled) setStatus(READY)
      },
      (err: unknown) => {
        const notice = err instanceof StorageNotice
        if (!notice) {
          logger.error('storage.prepareFailed', 'the database engine did not load', {
            error: safe(String(err)),
          })
        }
        if (!cancelled) {
          setStatus({ state: 'failed', reason: notice ? err.message : STORAGE_FAULT })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [status])
  return status
}
