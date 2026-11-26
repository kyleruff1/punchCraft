/**
 * The one audio rejection a browser raises that the tablet never does.
 *
 * In a browser, `play()` on a media element returns a promise, and that
 * promise rejects with `AbortError` when a `pause()` or a new load overtakes
 * it. expo-audio's web player calls `play()` and drops the promise, so every
 * clip the coach cuts short — which it does on purpose — surfaces as
 * "Uncaught (in promise)". One or two per workout, seen 2026-11-26.
 *
 * The play/pause sequences in this directory are measured against the
 * tablet's player, which has no such promise. Rather than reshape them to
 * suit a browser, this takes exactly that rejection off the page's unhandled
 * list and counts it. Anything else still reaches the console.
 *
 * Chromium's wording ("The play() request was interrupted by …") is what is
 * matched: Chrome and Edge are the browsers the PC version targets. Another
 * engine's differently-worded abort is left alone, loudly, rather than
 * guessed at.
 */
import { logger, safe } from '@diagnostics/logger'

export function isInterruptedPlay(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false
  const { name, message } = reason as { name?: unknown; message?: unknown }
  return name === 'AbortError' && typeof message === 'string' && message.includes('play() request')
}

/** The slice of `window` this needs — so a test can stand in for it. */
export interface RejectionSource {
  addEventListener(
    type: 'unhandledrejection',
    listener: (event: { reason: unknown; preventDefault(): void }) => void,
  ): void
}

export function ignoreInterruptedPlay(source: RejectionSource): void {
  let count = 0
  source.addEventListener('unhandledrejection', (event) => {
    if (!isInterruptedPlay(event.reason)) return
    event.preventDefault()
    count += 1
    logger.debug('audio.web.playInterrupted', 'a clip was cut short before it began', {
      count: safe(count),
    })
  })
}
