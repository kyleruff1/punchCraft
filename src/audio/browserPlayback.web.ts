/**
 * Browser-only audio set-up — Metro picks this over `browserPlayback.ts` for
 * the web build. See `interruptedPlay.ts` for the one thing it does and why.
 */
import { ignoreInterruptedPlay } from './interruptedPlay'

let prepared = false

export function prepareBrowserPlayback(): void {
  if (prepared) return
  prepared = true
  ignoreInterruptedPlay(window)
}
