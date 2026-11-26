/**
 * Whether storage may be used yet — what the root layout waits on.
 *
 * On the tablet the database opens synchronously, so this is `'ready'` on
 * the first render and nothing is ever awaited: the app mounts exactly as it
 * did before this existed. In a browser the engine and the saved file load
 * asynchronously (`database.web.ts`), and everything under the root layout
 * reads storage synchronously, so none of it may mount until they have.
 *
 * `'failed'` means the engine itself did not load. There is no database to
 * offer then; the layout says so rather than showing an empty page.
 */
import { useEffect, useState } from 'react'

import { logger, safe } from '@diagnostics/logger'
import { isStorageReady, prepareStorage } from '@storage/database'

export type StorageState = 'loading' | 'ready' | 'failed'

export function useStorageReady(): StorageState {
  const [state, setState] = useState<StorageState>(() => (isStorageReady() ? 'ready' : 'loading'))
  useEffect(() => {
    if (state !== 'loading') return
    let cancelled = false
    prepareStorage().then(
      () => {
        if (!cancelled) setState('ready')
      },
      (err: unknown) => {
        logger.error('storage.prepareFailed', 'the database engine did not load', {
          error: safe(String(err)),
        })
        if (!cancelled) setState('failed')
      },
    )
    return () => {
      cancelled = true
    }
  }, [state])
  return state
}
