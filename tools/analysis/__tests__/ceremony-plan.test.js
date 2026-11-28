/**
 * The ceremony expectations are what the app's own players build.
 *
 * `ceremony-plan.ts` restates two of the app's rules — how a walkout becomes
 * tracks, how a countdown is assembled — because the players that own them
 * build native playlists and cannot be called from a manifest generator. A
 * restated rule drifts; the manifest's copy of the call-pruning rule did, and
 * under-counted for months (N-20). So this runs the real players, with the
 * native playlist stubbed, and holds the restatement to the line each one
 * logs: for every sample workout, both vocabularies, and every one of the
 * fifteen lines a countdown can open with.
 *
 * What it does not prove is the live screen's wiring — which theme and which
 * lead-in it hands the countdown, which script it hands the rest. That is
 * three lines of `live.tsx`, repeated here; the captures prove it (the first
 * describe block pins one, read from a real whole-workout run).
 */
import { IntroPlayer } from '../../../src/audio/IntroPlayer'
import { planIntro } from '../../../src/audio/introPlan'
import { RoundWarningPlayer } from '../../../src/audio/RoundWarningPlayer'
import { findClickScript } from '../../../src/audio/voiceAssets/clickScriptManifest'
import { INTRO_SEGMENTS } from '../../../src/audio/voiceAssets/introManifest'
import { logger } from '../../../src/diagnostics/logger'
import { getSampleWorkout, listSampleWorkouts } from '../../../src/domain/workout/samples'
import {
  COUNTDOWN_OPENER_COUNT,
  countdownOpeners,
  expectedRest,
  expectedWalkout,
} from '../ceremony-plan'

jest.mock('expo-audio', () => ({
  createAudioPlaylist: jest.fn(() => ({
    play: jest.fn(),
    pause: jest.fn(),
    destroy: jest.fn(),
    release: jest.fn(),
    remove: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    volume: 0,
  })),
}))

jest.mock('@/diagnostics/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
  safe: (v) => v,
}))

/** The fields of the last line a player logged with this message. */
const logged = (message) => {
  const call = logger.info.mock.calls.filter((c) => c[1] === message).at(-1)
  return call ? call[2] : null
}

const KEYS = listSampleWorkouts().map((s) => s.key)
const VOCABULARIES = ['numbers', 'techniques']

beforeEach(() => {
  logger.info.mockClear()
  logger.warn.mockClear()
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('against a real capture (Body Work, numbers, whole workout on the PC, 2026-11-27)', () => {
  const workout = getSampleWorkout('body-work').workout

  it('the walkout: 4 clips, 7 tracks, 24,020 ms', () => {
    // 'intro loaded', { segments: 4, plannedMs: 24020, tracks: 7, boundaries: 6 }
    const walkout = expectedWalkout(workout, 'numbers')
    expect(walkout).toMatchObject({ plannedMs: 24_020, tracks: 7 })
    expect(walkout.segments).toHaveLength(4)
  })

  it('the first rest: script rr-3658e672, one track of 12,855 ms', () => {
    // 'recovery loaded', { scriptId: 'rr-3658e672', segments: 1, plannedMs: 12855, tracks: 1 }
    expect(expectedRest(workout, 0, 'numbers').restLine).toMatchObject({
      scriptId: 'rr-3658e672',
      slot: 'rest/body-work/r1',
      plannedMs: 12_855,
      tracks: 1,
    })
  })

  it('the countdown into round 2: 5 tracks, 15,648 ms with opener 02', () => {
    // 'round warning prepared', { round: 2, opener: 'warn-opener-02', totalMs: 15648, tracks: 5 }
    const countdown = expectedRest(workout, 0, 'numbers').countdown
    expect(countdown).toMatchObject({ round: 2, tracks: 5 })
    expect(countdown.afterOpenerMs + countdownOpeners()['warn-opener-02']).toBe(15_648)
  })

  it('has nothing after the last round', () => {
    expect(expectedRest(workout, workout.schedule.length - 1, 'numbers')).toBeNull()
  })
})

describe('the countdown’s openers', () => {
  it('are fifteen, each with a length', () => {
    const openers = countdownOpeners()
    expect(Object.keys(openers)).toHaveLength(COUNTDOWN_OPENER_COUNT)
    expect(Object.keys(openers)[0]).toBe('warn-opener-01')
    for (const ms of Object.values(openers)) expect(ms).toBeGreaterThan(0)
  })
})

describe('every rest in the sample workouts has an authored script', () => {
  it.each(VOCABULARIES)('%s: 41 rests, none left to the generic walkthrough', (vocabulary) => {
    let rests = 0
    for (const key of KEYS) {
      const workout = getSampleWorkout(key).workout
      for (let round = 0; round < workout.schedule.length - 1; round += 1) {
        rests += 1
        expect(expectedRest(workout, round, vocabulary).restLine).not.toBeNull()
      }
    }
    expect(rests).toBe(41)
  })
})

describe.each(VOCABULARIES)('held to the players — %s', (vocabulary) => {
  it.each(KEYS)('%s: the walkout is what IntroPlayer loads', (key) => {
    const workout = getSampleWorkout(key).workout
    new IntroPlayer().load(planIntro(workout, INTRO_SEGMENTS, vocabulary).segments)
    const line = logged('intro loaded')
    const walkout = expectedWalkout(workout, vocabulary)
    expect({ segments: line.segments, plannedMs: line.plannedMs, tracks: line.tracks }).toEqual({
      segments: walkout.segments.length,
      plannedMs: walkout.plannedMs,
      tracks: walkout.tracks,
    })
  })

  it.each(KEYS)('%s: each countdown is what RoundWarningPlayer prepares, whichever opener', (key) => {
    const workout = getSampleWorkout(key).workout
    const openers = countdownOpeners()
    const random = jest.spyOn(Math, 'random')
    for (let round = 0; round < workout.schedule.length - 1; round += 1) {
      const countdown = expectedRest(workout, round, vocabulary).countdown
      // The live screen's wiring (`live.tsx`, the warn effect).
      const lead = findClickScript(`lead-in/${workout.id}/r${round + 2}s1`, vocabulary)
      for (let opener = 1; opener <= COUNTDOWN_OPENER_COUNT; opener += 1) {
        random.mockReturnValue((opener - 0.5) / COUNTDOWN_OPENER_COUNT)
        new RoundWarningPlayer().prepare(
          round + 2,
          workout.schedule[round + 1]?.theme,
          lead ? { module: lead.module, durationMs: lead.durationMs } : undefined,
        )
        const line = logged('round warning prepared')
        expect(line.opener).toBe(`warn-opener-${String(opener).padStart(2, '0')}`)
        expect({
          round: line.round,
          afterOpenerMs: line.totalMs - openers[line.opener],
          tracks: line.tracks,
        }).toEqual({
          round: countdown.round,
          afterOpenerMs: countdown.afterOpenerMs,
          tracks: countdown.tracks,
        })
      }
    }
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
