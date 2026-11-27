/**
 * The key a per-bar call clip is filed under.
 *
 * A call names the bar the athlete is about to throw — "One, two, three,
 * two!" — and one clip serves every bar with that shape, in every workout.
 * The shape is the bar's MOTIF: its tokens in order, a punch as its number
 * (with `b` for the body), anything else as `.`. The slot is `call/<motif>`.
 *
 * This used to be spelled out by hand in three places — the runner, the
 * verifier's manifest generator and a fitting script — which agreed only
 * because nobody had changed one of them. They share this now.
 *
 * `discipline` is the segment that keeps another pack's calls apart
 * (`discipline.ts`). Boxing is the absent segment, so every slot that
 * existed before is spelled exactly as it was.
 */
import { BOXING, type Discipline } from '@domain/workout/discipline'

/** The slice of a workout token the motif is made from. */
export interface MotifToken {
  kind: string
  number?: number
  body?: boolean
}

export function motifOf(tokens: readonly MotifToken[]): string {
  return tokens.map((t) => (t.kind === 'punch' ? `${t.number}${t.body ? 'b' : ''}` : '.')).join('-')
}

export function callSlot(motif: string, discipline: Discipline = BOXING): string {
  return discipline === BOXING ? `call/${motif}` : `call/${discipline}/${motif}`
}
