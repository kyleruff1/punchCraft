/**
 * Voice settings read back from storage are checked, not trusted.
 *
 * The persistence round trip is covered in `useVoiceSettingsStore.test.ts`
 * against real SQLite. These are the two pure functions on their own.
 */
import {
  defaultVoiceCoachPolicy,
  normalizeVoiceCoachPolicy,
  voiceAllowed,
} from '../VoiceCoachPolicy'
import { DEFAULT_VOLUMES, normalizeVolumes } from '../VoiceOutputPort'

describe('normalizeVoiceCoachPolicy', () => {
  it('returns the defaults for an empty object', () => {
    expect(normalizeVoiceCoachPolicy({})).toEqual(defaultVoiceCoachPolicy())
  })

  it.each([['false'], ['true'], [1], [0], [{}], [[]], [null], [undefined]])(
    'reads overlayOptIn %p as not opted in',
    (stored) => {
      const policy = normalizeVoiceCoachPolicy({ overlayOptIn: stored })
      expect(policy.overlayOptIn).toBe(false)
      expect(voiceAllowed(policy, true)).toBe(false)
    },
  )

  it('reads only literal true as an opt-in', () => {
    expect(normalizeVoiceCoachPolicy({ overlayOptIn: true }).overlayOptIn).toBe(true)
  })

  it('keeps each known value and replaces each unknown one', () => {
    expect(
      normalizeVoiceCoachPolicy({
        mode: 'full',
        style: 'follow-the-call',
        vocabulary: 'numbers',
        metricAnnouncements: 'off',
        finalTenSecondWarning: false,
      }),
    ).toEqual({
      mode: 'full',
      style: 'follow-the-call',
      vocabulary: 'numbers',
      overlayOptIn: false,
      metricAnnouncements: 'off',
      finalTenSecondWarning: false,
    })

    expect(
      normalizeVoiceCoachPolicy({
        mode: 7,
        style: null,
        vocabulary: 'names ',
        metricAnnouncements: true,
        finalTenSecondWarning: 0,
      }),
    ).toEqual(defaultVoiceCoachPolicy())
  })

  it('still migrates a retired style', () => {
    expect(normalizeVoiceCoachPolicy({ style: 'coach-shorthand' }).style).toBe('call-and-go')
  })

  it('carries nothing through that is not a policy field', () => {
    const policy = normalizeVoiceCoachPolicy({ mode: 'off', extra: true } as never)
    expect(Object.keys(policy).sort()).toEqual(Object.keys(defaultVoiceCoachPolicy()).sort())
  })
})

describe('normalizeVolumes', () => {
  it('returns the defaults for an empty object', () => {
    expect(normalizeVolumes({})).toEqual(DEFAULT_VOLUMES)
  })

  it('keeps a level inside 0-1, including both ends', () => {
    expect(normalizeVolumes({ voice: 0, bells: 1, haptics: 0.5, metronome: 0.25 })).toEqual({
      voice: 0,
      bells: 1,
      haptics: 0.5,
      metronome: 0.25,
    })
  })

  it('clamps a level outside it', () => {
    expect(normalizeVolumes({ voice: 7, bells: -3 })).toMatchObject({ voice: 1, bells: 0 })
  })

  it.each([['0.5'], [Number.NaN], [Number.POSITIVE_INFINITY], [null], [true], [{}]])(
    'replaces %p with the default',
    (stored) => {
      expect(normalizeVolumes({ metronome: stored }).metronome).toBe(DEFAULT_VOLUMES.metronome)
    },
  )
})
