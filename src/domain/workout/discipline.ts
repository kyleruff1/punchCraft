/**
 * Which discipline a workout belongs to — the segment that keeps one pack's
 * recorded calls and avatar art apart from another's.
 *
 * Today there is one, boxing, and it is spelled as the ABSENT segment: a
 * workout with no `discipline` is boxing, a boxing call clip is
 * `call/<motif>`, and boxing's avatar frames are the set that has always
 * been there. So nothing that exists moved when this was added — no clip was
 * re-keyed, no audio re-rendered, no stored plan re-hashed.
 *
 * It exists now, with nothing using it, because of what it costs later. The
 * clip key and the avatar key had no discipline dimension, and re-keying
 * them gets more expensive with every workout shipped: each re-key of a call
 * clip is a re-render through the speech gate, the slowest step in the loop
 * (`docs/handoff/08-review-and-roadmap.md` §4). Adding the segment while it
 * is empty costs one function.
 *
 * A discipline's name becomes part of clip slots and asset paths, so it is a
 * lowercase slug.
 */
export type Discipline = string

export const BOXING: Discipline = 'boxing'

const SLUG = /^[a-z][a-z0-9-]*$/

export function isDisciplineSlug(value: unknown): value is Discipline {
  return typeof value === 'string' && SLUG.test(value)
}

/** The discipline a workout runs under (`boxing` unless it says otherwise). */
export function disciplineOf(workout: { discipline?: Discipline }): Discipline {
  return workout.discipline ?? BOXING
}
