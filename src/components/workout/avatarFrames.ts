/**
 * Which avatar frames a punch token shows, by discipline.
 *
 * `punchAvatarManifest.ts` is generated from boxing's source art and is a
 * flat list keyed by punch number and body flag — with nowhere to put a
 * second set. Regenerating it for another discipline's art would have
 * overwritten boxing's under the same keys. This registry is where a second
 * set goes; boxing's is the generated one, untouched.
 *
 * A discipline with no art of its own gets `undefined`, and the card shows
 * the guard frame. It does not fall back to boxing's punches: an avatar
 * throwing a jab for some other move is worse than one standing in guard.
 */
import type { PunchNumber } from '@domain/workout/WorkoutTokens'
import { BOXING, type Discipline } from '@domain/workout/discipline'

import { punchAvatarFrames, type PunchAvatarFrames } from './punchAvatarManifest'

const AVATAR_SETS: Readonly<Record<Discipline, readonly PunchAvatarFrames[]>> = {
  [BOXING]: punchAvatarFrames,
}

export function avatarFramesFor(
  number: PunchNumber,
  body: boolean,
  discipline: Discipline = BOXING,
  sets: Readonly<Record<Discipline, readonly PunchAvatarFrames[]>> = AVATAR_SETS,
): PunchAvatarFrames | undefined {
  return sets[discipline]?.find((f) => f.number === number && f.body === body)
}
