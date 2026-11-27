/**
 * Which recorded clip speaks a bar's call.
 *
 * `clickScriptManifest.ts` is generated and knows only slots. This is the
 * rule on top of it — hand-written, so the generator never has to change to
 * change it.
 *
 * Boxing resolves exactly as it always has: the slot `call/<motif>`, in the
 * asked vocabulary, falling back to the numbers copy when a techniques clip
 * was never rendered.
 *
 * Another discipline looks for its own clip first. If it has none, it may
 * borrow the SHARED NUMBERS clip — "one, two, three, two" names positions,
 * not boxing — and that is what lets a new pack run on the calls already
 * recorded. It never borrows the shared techniques clip: those words are
 * boxing's ("jab, cross, hook"), and a pack that spoke them for its own
 * moves would be wrong in a way no test would notice.
 */
import { callSlot } from '@domain/coach/callSlot'
import { BOXING, type Discipline } from '@domain/workout/discipline'

import { CLICK_SCRIPT_CLIPS, type ClickScriptClip } from './clickScriptManifest'

export type CallVocabulary = ClickScriptClip['vocabulary']

export interface FoundCallClip {
  /** The slot the clip was found under — the key its timing overrides use. */
  slot: string
  clip: ClickScriptClip
}

export function findCallClip(
  motif: string,
  vocabulary: CallVocabulary = 'numbers',
  discipline: Discipline = BOXING,
  clips: readonly ClickScriptClip[] = CLICK_SCRIPT_CLIPS,
): FoundCallClip | undefined {
  const at = (slot: string, spoken: CallVocabulary): FoundCallClip | undefined => {
    const clip = clips.find((c) => c.vocabulary === spoken && c.slots.includes(slot))
    return clip ? { slot, clip } : undefined
  }
  const own = callSlot(motif, discipline)
  const shared = callSlot(motif)
  return (
    at(own, vocabulary) ??
    (vocabulary === 'techniques' ? at(own, 'numbers') : undefined) ??
    (own === shared ? undefined : at(shared, 'numbers'))
  )
}
