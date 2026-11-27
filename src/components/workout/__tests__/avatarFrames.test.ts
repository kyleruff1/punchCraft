/**
 * Which avatar frames a punch shows, by discipline.
 */
import { avatarFramesFor } from '../avatarFrames'
import { findPunchAvatar, punchAvatarFrames } from '../punchAvatarManifest'
import type { PunchNumber } from '@domain/workout/WorkoutTokens'

describe('avatarFramesFor', () => {
  it('gives boxing exactly the frames the generated manifest always gave', () => {
    for (const frames of punchAvatarFrames) {
      expect(avatarFramesFor(frames.number, frames.body)).toBe(frames)
      expect(avatarFramesFor(frames.number, frames.body, 'boxing')).toBe(
        findPunchAvatar(frames.number, frames.body),
      )
    }
    expect(punchAvatarFrames).toHaveLength(12)
  })

  it('gives a discipline with no art nothing — not boxing’s punches', () => {
    expect(avatarFramesFor(1, false, 'reaction')).toBeUndefined()
  })

  it('finds a second discipline’s own set once it has one', () => {
    const own = { key: '1', number: 1 as PunchNumber, body: false, step1: 901, step2: 902 }
    const sets = { boxing: punchAvatarFrames, reaction: [own] }
    expect(avatarFramesFor(1, false, 'reaction', sets)).toBe(own)
    expect(avatarFramesFor(2, false, 'reaction', sets)).toBeUndefined()
    expect(avatarFramesFor(1, false, 'boxing', sets)).toBe(punchAvatarFrames[0])
  })
})
