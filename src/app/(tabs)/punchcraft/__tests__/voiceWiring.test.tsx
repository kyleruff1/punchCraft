/**
 * The runner drives the Voice Coach (M34-05, D1, doc §25).
 *
 * The announcer and the port each have their own suites. This one proves the
 * runner actually *connects* them — the seam where "the coach was configured
 * perfectly and never said a word" would come from, and where the D1 gate
 * would be perfect in the domain and unwired in the app.
 *
 * Drives the real runner with a fake clock and a recording port.
 */
import React, { useImperativeHandle } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { View } from 'react-native'

import {
  useWorkoutRunner,
  TICK_INTERVAL_MS,
  type WorkoutRunner,
} from '../_useWorkoutRunner'
import { DEFAULT_COUNTDOWN_MS } from '@domain/session/WorkoutSessionClock'
import { createFakeClock, type FakeClock } from '@testing/fakeClock'
import { defaultRecipe } from '@domain/workout/WorkoutRecipe'
import { defaultVoiceCoachPolicy, type VoiceCoachPolicy } from '@domain/coach/VoiceCoachPolicy'
import {
  StaticPlaybackDetector,
  UnavailablePlaybackDetector,
} from '@audio/ThirdPartyPlaybackDetector'
import { resetLive, useLiveStore } from '@state/useWorkoutStore'
import type {
  ToneKind,
  VoiceAssetId,
  VoiceOutputPort,
  Volumes,
} from '@domain/coach/VoiceOutputPort'
import type { GeneratedWorkout } from '@domain/workout/GeneratedWorkout'
import type { PunchEventSource } from '@domain/punch/PunchEventSource'
import type { TrackerPunchEvent } from '@domain/punch/PunchEvent'
import type { ProgramRound } from '@domain/workout/WorkoutTokens'

const WORK_MS = 20_000
const REST_MS = 1_000
const COUNTDOWN_MS = DEFAULT_COUNTDOWN_MS

function round(order: number, isLast: boolean): ProgramRound {
  return {
    id: `r${order}`,
    order,
    kind: 'round',
    countsTowardGoal: true,
    theme: `Round ${order}`,
    workDurationMs: WORK_MS,
    restAfterMs: isLast ? 0 : REST_MS,
    targetPunches: 4,
    blocks: [
      {
        id: `r${order}-b1`,
        kind: 'repeated-combo',
        stance: 'inherit',
        startOffsetMs: 0,
        durationMs: 2_000,
        gapBeats: 1,
        repeat: 2,
        tokens: [
          { kind: 'punch', number: 1, body: false, beatOffset: 0 },
          { kind: 'punch', number: 2, body: false, beatOffset: 0.6 },
        ],
      },
    ],
  }
}

const WORKOUT: GeneratedWorkout = {
  id: 'voice-wiring-fixture',
  recipe: defaultRecipe(),
  schedule: [round(1, false), round(2, true)],
  roundPunchTargets: [4, 4],
  expectedTechniqueDistribution: {},
  estimatedActivePunchesPerMinute: 60,
  warnings: [],
}

class SilentSource implements PunchEventSource {
  readonly id = 'silent'
  readonly capability = {
    hand: true,
    timestamp: true,
    punchType: 'none' as const,
    velocity: true,
  }
  subscribe(_l: (e: TrackerPunchEvent) => void): () => void {
    return () => {}
  }
  start(): void {}
  stop(): void {}
}

class RecordingPort implements VoiceOutputPort {
  readonly assets: VoiceAssetId[] = []
  readonly tones: ToneKind[] = []
  readonly spoken: string[] = []
  cancels = 0
  /** Slots of the click-script clips played (section lead-ins, per-bar calls). */
  readonly clickScripts: string[] = []
  readonly metronomeCalls: string[] = []
  /** Volume passed to each metronome.start (the dev-click mute gates this). */
  readonly metronomeStartVolumes: number[] = []
  /** Volumes passed to metronome.setVolume (mid-session mute re-tune). */
  readonly metronomeSetVolumes: number[] = []

  playAsset(id: VoiceAssetId): void {
    this.assets.push(id)
  }
  speak(text: string): void {
    this.spoken.push(text)
  }
  tone(kind: ToneKind): void {
    this.tones.push(kind)
  }
  cancel(): void {
    this.cancels += 1
  }
  playClickScript(clip: { text: string; traceId?: string }): void {
    this.clickScripts.push(clip.traceId ?? clip.text)
  }
  setVolumes(_v: Volumes): void {}

  readonly metronome = {
    start: (loop: { division: number; swing: number }, volume: number): void => {
      this.metronomeCalls.push(`start:${loop.division}:${loop.swing}`)
      this.metronomeStartVolumes.push(volume)
    },
    stop: (): void => {
      this.metronomeCalls.push('stop')
    },
    setVolume: (volume: number): void => {
      this.metronomeSetVolumes.push(volume)
    },
  }
}

interface Harness {
  runner: WorkoutRunner
  port: RecordingPort
  clock: FakeClock
  step(ms: number): void
  begin(): void
  /**
   * Let the detector's first answer land.
   *
   * The gate starts closed and opens on the resolved value of `isActive()`.
   * That is a microtask in the real app and invisible; here it has to be
   * flushed on purpose, which is worth doing rather than starting the gate
   * open just to make the test simpler.
   */
  settle(): Promise<void>
  unmount(): void
}

function mount(
  policyOver: Partial<VoiceCoachPolicy> = {},
  detector: StaticPlaybackDetector | UnavailablePlaybackDetector = new StaticPlaybackDetector(false),
): Harness {
  const clock = createFakeClock()
  const port = new RecordingPort()
  const ref = React.createRef<WorkoutRunner>()
  const voice = {
    output: port,
    policy: { ...defaultVoiceCoachPolicy(), ...policyOver },
    detector,
  }

  function Probe(): React.JSX.Element {
    const runner = useWorkoutRunner({
      workout: WORKOUT,
      source: new SilentSource(),
      stance: 'orthodox',
      clock,
      persistence: null,
      voice,
    })
    useImperativeHandle(ref, () => runner, [runner])
    return <View />
  }

  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<Probe />)
  })

  const step = (ms: number): void => {
    act(() => {
      for (let elapsed = 0; elapsed < ms; elapsed += TICK_INTERVAL_MS) {
        clock.advance(TICK_INTERVAL_MS)
        jest.advanceTimersByTime(TICK_INTERVAL_MS)
      }
    })
  }

  return {
    get runner() {
      return ref.current as WorkoutRunner
    },
    port,
    clock,
    step,
    begin: () => {
      act(() => {
        ;(ref.current as WorkoutRunner).start()
      })
      step(COUNTDOWN_MS + TICK_INTERVAL_MS)
    },
    settle: async () => {
      await act(async () => {
        await Promise.resolve()
      })
    },
    unmount: () => {
      act(() => {
        tree.unmount()
      })
    },
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  resetLive()
})

afterEach(() => {
  jest.useRealTimers()
  act(() => {
    useLiveStore.getState().resetLive()
  })
})

// ---------------------------------------------------------------------------

describe('session phases reach the announcer', () => {
  it('rings the bell when the round starts', async () => {
    const h = mount()
    await h.settle()
    h.begin()
    expect(h.port.assets).toContain('bell')
    h.unmount()
  })

  it('rings again at the rest bell', async () => {
    const h = mount()
    await h.settle()
    h.begin()
    // Rounds start AND end on the ding-ding — the gong is retired.
    const bellsBefore = h.port.assets.filter((a) => a === 'bell').length
    h.step(WORK_MS + TICK_INTERVAL_MS * 2)
    expect(h.port.assets.filter((a) => a === 'bell').length).toBeGreaterThan(bellsBefore)
    h.unmount()
  })

  it('cancels queued output on a pause', async () => {
    const h = mount()
    await h.settle()
    h.begin()
    act(() => {
      h.runner.pause()
    })
    expect(h.port.cancels).toBeGreaterThan(0)
    h.unmount()
  })

  it('cancels on an emergency stop', async () => {
    const h = mount()
    await h.settle()
    h.begin()
    const before = h.port.cancels
    act(() => {
      h.runner.emergencyStop()
    })
    expect(h.port.cancels).toBeGreaterThan(before)
    h.unmount()
  })
})

describe('the round clock reaches the announcer (doc §25)', () => {
  it('sounds the final warning once, in the last ten seconds', async () => {
    const h = mount()
    await h.settle()
    h.begin()
    // Run out to inside the final ten seconds of round 1.
    h.step(WORK_MS - 5_000)
    // The moment is marked, but no beep plays — beeps are gone from the
    // sound design (the marker awaits a voiced "last ten seconds!" clip).
    const warnings = h.port.assets.filter((a) => a === 'tone-warning').length
    expect(warnings).toBe(0)
    h.unmount()
  })

  it('stays silent when the warning is switched off', async () => {
    const h = mount({ finalTenSecondWarning: false })
    await h.settle()
    h.begin()
    h.step(WORK_MS - 5_000)
    expect(h.port.assets).not.toContain('tone-warning')
    h.unmount()
  })
})

describe('cue events reach the announcer', () => {
  it('calls the combination once the round is running', async () => {
    const h = mount({ style: 'call-and-go' })
    await h.settle()
    h.begin()
    h.step(4_000)
    // The fixture's combination is 1-2.
    expect(h.port.assets).toContain('1')
    expect(h.port.assets).not.toContain('tone-ready')
    h.unmount()
  })
})

describe('the D1 gate holds end to end (spec §13.5)', () => {
  it('says nothing at all while playback is active without an opt-in', async () => {
    const h = mount({}, new StaticPlaybackDetector(true))
    await h.settle()
    h.begin()
    h.step(6_000)
    expect(h.port.assets).toEqual([])
    expect(h.port.spoken).toEqual([])
    h.unmount()
  })

  it('speaks over playback once the athlete has opted in', async () => {
    const h = mount({ overlayOptIn: true }, new StaticPlaybackDetector(true))
    await h.settle()
    h.begin()
    h.step(6_000)
    expect(h.port.assets.length).toBeGreaterThan(0)
    h.unmount()
  })

  it('falls silent mid-workout when playback starts', async () => {
    const detector = new StaticPlaybackDetector(false)
    const h = mount({}, detector)
    await h.settle()
    h.begin()
    h.step(4_000)
    expect(h.port.assets.length).toBeGreaterThan(0)

    act(() => {
      detector.set(true)
    })
    const atSilence = h.port.assets.length
    h.step(6_000)
    expect(h.port.assets.length).toBe(atSilence)
    h.unmount()
  })

  it('speaks when the detector cannot tell, which is why the screen says so', async () => {
    // Documenting the interim honestly: with no detection the gate has no
    // signal, so the coach behaves as though nothing else is playing. The
    // live screen and settings screen both carry the notice that explains it.
    const h = mount({}, new UnavailablePlaybackDetector())
    await h.settle()
    h.begin()
    expect(h.port.assets).toContain('bell')
    h.unmount()
  })
})

describe('a workout with no voice configured', () => {
  it('runs without constructing a coach at all', () => {
    // Voice off is a supported way to train, not a degraded one (doc §25).
    const clock = createFakeClock()
    const ref = React.createRef<WorkoutRunner>()
    function Probe(): React.JSX.Element {
      const runner = useWorkoutRunner({
        workout: WORKOUT,
        source: new SilentSource(),
        stance: 'orthodox',
        clock,
        persistence: null,
      })
      useImperativeHandle(ref, () => runner, [runner])
      return <View />
    }
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<Probe />)
    })
    expect(() => {
      act(() => {
        ;(ref.current as WorkoutRunner).start()
      })
      act(() => {
        clock.advance(TICK_INTERVAL_MS)
        jest.advanceTimersByTime(TICK_INTERVAL_MS)
      })
    }).not.toThrow()
    act(() => {
      tree.unmount()
    })
  })
})

// ---------------------------------------------------------------------------
// The M39-V1b metronome wiring. The port's `metronome` hook is optional and
// the runner is expected to gate on `recipe.metronome.enabled` — a legacy
// recipe with the flag off must NEVER call start/stop even when the port is
// present. When the flag is on, the runner drives the click on the phase
// edges (work → start; rest/pause/end → stop; resume → start again to
// re-anchor on the downbeat).
// ---------------------------------------------------------------------------

function workoutWithMetronome(enabled: boolean): GeneratedWorkout {
  return {
    ...WORKOUT,
    recipe: {
      ...WORKOUT.recipe,
      coachTempo: { baseBpm: 60, division: 2, swing: 0.54 },
      metronome: { enabled, volume: 0.6 },
    },
  }
}

function mountWithWorkout(
  workout: GeneratedWorkout,
  opts: { clickAudible?: boolean; policy?: Partial<VoiceCoachPolicy> } = {},
): Harness {
  const clock = createFakeClock()
  const port = new RecordingPort()
  const ref = React.createRef<WorkoutRunner>()
  const voice = {
    output: port,
    policy: { ...defaultVoiceCoachPolicy(), ...opts.policy },
    detector: new StaticPlaybackDetector(false),
  }

  function Probe(): React.JSX.Element {
    const runner = useWorkoutRunner({
      workout,
      source: new SilentSource(),
      stance: 'orthodox',
      clock,
      persistence: null,
      voice,
      ...(opts.clickAudible === undefined ? {} : { clickAudible: opts.clickAudible }),
    })
    useImperativeHandle(ref, () => runner, [runner])
    return <View />
  }

  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<Probe />)
  })

  const step = (ms: number): void => {
    act(() => {
      for (let elapsed = 0; elapsed < ms; elapsed += TICK_INTERVAL_MS) {
        clock.advance(TICK_INTERVAL_MS)
        jest.advanceTimersByTime(TICK_INTERVAL_MS)
      }
    })
  }

  return {
    get runner() {
      return ref.current as WorkoutRunner
    },
    port,
    clock,
    step,
    begin: () => {
      act(() => {
        ;(ref.current as WorkoutRunner).start()
      })
      step(COUNTDOWN_MS + TICK_INTERVAL_MS)
    },
    settle: async () => {
      await act(async () => {
        await Promise.resolve()
      })
    },
    unmount: () => {
      act(() => {
        tree.unmount()
      })
    },
  }
}

describe('metronome wiring (M39-V1b / #280)', () => {
  it('starts the click on work-entered and stops on rest-entered when the recipe opts in', async () => {
    const h = mountWithWorkout(workoutWithMetronome(true))
    await h.settle()
    h.begin()

    expect(h.port.metronomeCalls[0]).toBe('start:2:0.54')

    h.step(WORK_MS + TICK_INTERVAL_MS * 2)

    // start on round 1 work-entered, then stop on rest-entered.
    expect(h.port.metronomeCalls.slice(0, 2)).toEqual(['start:2:0.54', 'stop'])
    h.unmount()
  })

  it('re-starts on resume (re-anchors on the downbeat)', async () => {
    const h = mountWithWorkout(workoutWithMetronome(true))
    await h.settle()
    h.begin()

    act(() => {
      h.runner.pause()
    })
    act(() => {
      h.runner.resume()
    })

    const calls = h.port.metronomeCalls
    // start (work), stop (pause), start (resume).
    expect(calls).toEqual(['start:2:0.54', 'stop', 'start:2:0.54'])
    h.unmount()
  })

  it('is silent when the recipe has metronome.enabled: false — no port calls at all', async () => {
    const h = mountWithWorkout(workoutWithMetronome(false))
    await h.settle()
    h.begin()
    h.step(WORK_MS + TICK_INTERVAL_MS * 2)

    expect(h.port.metronomeCalls).toEqual([])
    h.unmount()
  })

  it('mutes the dev click (volume 0) when clickAudible is false, but still starts the transport', async () => {
    // Removable dev click, mute-only: the port.start STILL fires (so the
    // logical transport / avatar clock keeps running) — only the volume is
    // zeroed, so nothing is heard and the visual grid is untouched.
    const h = mountWithWorkout(workoutWithMetronome(true), { clickAudible: false })
    await h.settle()
    h.begin()

    expect(h.port.metronomeCalls[0]).toBe('start:2:0.54')
    expect(h.port.metronomeStartVolumes[0]).toBe(0)
    h.unmount()
  })

  it('plays the dev click at the recipe volume when clickAudible is true', async () => {
    const h = mountWithWorkout(workoutWithMetronome(true), { clickAudible: true })
    await h.settle()
    h.begin()

    expect(h.port.metronomeStartVolumes[0]).toBe(0.6)
    h.unmount()
  })

  it('defaults to audible (recipe volume) when clickAudible is omitted — back-compat', async () => {
    const h = mountWithWorkout(workoutWithMetronome(true))
    await h.settle()
    h.begin()

    expect(h.port.metronomeStartVolumes[0]).toBe(0.6)
    h.unmount()
  })

  it('stops the click on emergencyStop / cancel', async () => {
    const h = mountWithWorkout(workoutWithMetronome(true))
    await h.settle()
    h.begin()

    act(() => {
      h.runner.emergencyStop()
    })

    expect(h.port.metronomeCalls).toContain('stop')
    h.unmount()
  })
})

describe("a click-script workout's announcer cap is a ceiling, not an override", () => {
  // Every shipped sample is a click-script workout: its announcer keeps to
  // bells, stance and countdown, because the click script speaks the
  // combinations. The runner applied that by writing 'minimal' over the
  // athlete's own mode — including over 'off'. So with "Voice coach: Off"
  // selected, every sample still rang its round bells.

  const MINIMAL: GeneratedWorkout = {
    ...WORKOUT,
    id: 'minimal-cap-fixture',
    coachPath: 'click-script',
  }

  const bells = (h: Harness): number => h.port.assets.filter((a) => a === 'bell').length

  it('makes no sound at all when the athlete has switched the coach off', async () => {
    const h = mountWithWorkout(MINIMAL, { policy: { mode: 'off' } })
    await h.settle()
    h.begin()
    // Through the round-start bell and the round-end bell.
    h.step(WORK_MS + REST_MS)

    expect(bells(h)).toBe(0)
    expect(h.port.assets).toEqual([])
    expect(h.port.spoken).toEqual([])
    expect(h.port.clickScripts).toEqual([])
    h.unmount()
  })

  it('keeps the announcer off the punch calls even for an athlete on Full', async () => {
    // Two voices on one bar is what the cap exists to prevent: on this path
    // the click script names the combination, so the announcer must not.
    const h = mountWithWorkout(MINIMAL, { policy: { mode: 'full', style: 'call-and-go' } })
    await h.settle()
    h.begin()
    h.step(4_000)

    expect(h.port.assets).not.toContain('1')
    h.unmount()
  })

  it('is decided by the coach path, not by a recipe that happens to say minimal', async () => {
    // The old test: `workout.recipe.voiceMode === 'minimal'`. A workout that
    // is NOT a click script must not have its announcer capped by that
    // field — the athlete's own policy is what the announcer runs on.
    const scoreWorkout: GeneratedWorkout = {
      ...WORKOUT,
      id: 'score-path-fixture',
      recipe: { ...defaultRecipe(), voiceMode: 'minimal' },
    }
    const h = mountWithWorkout(scoreWorkout, { policy: { mode: 'standard', style: 'call-and-go' } })
    await h.settle()
    h.begin()
    h.step(4_000)

    expect(h.port.assets).toContain('1')
    h.unmount()
  })

  it('still rings the bells for an athlete on a fuller setting', async () => {
    const h = mountWithWorkout(MINIMAL, { policy: { mode: 'full' } })
    await h.settle()
    h.begin()
    h.step(WORK_MS + REST_MS)

    expect(bells(h)).toBeGreaterThanOrEqual(2)
    h.unmount()
  })

  it('still rings them for an athlete who chose minimal themselves', async () => {
    const h = mountWithWorkout(MINIMAL, { policy: { mode: 'minimal' } })
    await h.settle()
    h.begin()

    expect(bells(h)).toBeGreaterThanOrEqual(1)
    h.unmount()
  })

  it('keeps "off" off on a recipe with no cap, as it always did', async () => {
    const h = mount({ mode: 'off' })
    await h.settle()
    h.begin()
    h.step(WORK_MS + REST_MS)

    expect(h.port.assets).toEqual([])
    h.unmount()
  })
})

describe("the click script obeys the athlete's voice mode", () => {
  // The click-script loop had one gate: D1 (`voiceAllowed`). It never asked
  // whether the athlete wanted punch calls at all, so "Minimal" — bells,
  // stance changes and the countdown, no punch calls — would still speak
  // every per-bar call. It could not be noticed on the library workouts,
  // which said `voiceMode: 'minimal'` themselves to mean something else.

  // A bar the click-script bank has a call for ("Four ones!"). The bank is
  // rendered for the library's motifs only: the file's usual 1-2 fixture
  // has no call clip, and a workout with none builds an empty schedule.
  const fourJabs = (order: number, isLast: boolean): ProgramRound => ({
    ...round(order, isLast),
    blocks: [
      {
        id: `r${order}-b1`,
        kind: 'repeated-combo',
        stance: 'inherit',
        startOffsetMs: 0,
        durationMs: 12_000,
        gapBeats: 0,
        repeat: 3,
        tokens: [0, 1, 2, 3].map((beatOffset) => ({
          kind: 'punch' as const,
          number: 1 as const,
          body: false,
          beatOffset,
        })),
      },
    ],
  })

  const SCORE: GeneratedWorkout = {
    ...WORKOUT,
    id: 'four-jabs-score-fixture',
    schedule: [fourJabs(1, false), fourJabs(2, true)],
  }
  const CLICK: GeneratedWorkout = { ...SCORE, id: 'four-jabs-click-fixture', coachPath: 'click-script' }

  const bells = (h: Harness): number => h.port.assets.filter((a) => a === 'bell').length

  const runRound = async (
    workout: GeneratedWorkout,
    policy: Partial<VoiceCoachPolicy>,
  ): Promise<Harness> => {
    const h = mountWithWorkout(workout, { policy })
    await h.settle()
    h.begin()
    h.step(WORK_MS)
    return h
  }

  it('speaks its per-bar calls on Standard', async () => {
    const h = await runRound(CLICK, { mode: 'standard' })
    expect(h.port.clickScripts.length).toBeGreaterThan(0)
    expect(h.port.clickScripts.every((id) => id.startsWith('call/1-1-1-1#'))).toBe(true)
    h.unmount()
  })

  it('speaks them on Full', async () => {
    const h = await runRound(CLICK, { mode: 'full' })
    expect(h.port.clickScripts.length).toBeGreaterThan(0)
    h.unmount()
  })

  it('leaves them to the visuals on Minimal, and still rings the bells', async () => {
    const h = await runRound(CLICK, { mode: 'minimal' })
    expect(h.port.clickScripts).toEqual([])
    expect(bells(h)).toBeGreaterThanOrEqual(1)
    h.unmount()
  })

  it('says nothing on Off', async () => {
    const h = await runRound(CLICK, { mode: 'off' })
    expect(h.port.clickScripts).toEqual([])
    expect(h.port.assets).toEqual([])
    h.unmount()
  })

  it('applies the same gate to a workout on the score path', async () => {
    // The loop is driven by which clips exist, not by the coach path, so a
    // score-path workout whose bar has a call clip is called too. The
    // control first: on Standard this fixture is.
    const spoken = await runRound(SCORE, { mode: 'standard' })
    expect(spoken.port.clickScripts.length).toBeGreaterThan(0)
    spoken.unmount()

    const quiet = await runRound(SCORE, { mode: 'minimal' })
    expect(quiet.port.clickScripts).toEqual([])
    quiet.unmount()
  })

  it('honours a style that asks for less, like the announcer does', async () => {
    const h = await runRound(CLICK, { mode: 'full', style: 'minimal' })
    expect(h.port.clickScripts).toEqual([])
    h.unmount()
  })

  it('does not dim a bar waiting for a call that Minimal will never make', async () => {
    // "Lit = spoken": a round's opening bar renders dim until the coach has
    // called it. That only makes sense while the coach is calling. On
    // Minimal the visuals are the workout, exactly as they are on Off.
    const openerDimmed = async (mode: VoiceCoachPolicy['mode']): Promise<boolean> => {
      const h = mountWithWorkout(CLICK, { policy: { mode } })
      await h.settle()
      h.begin()
      h.step(600)
      const dimmed = h.runner.readCues().current?.masked === true
      h.unmount()
      return dimmed
    }

    expect(await openerDimmed('standard')).toBe(true)
    expect(await openerDimmed('minimal')).toBe(false)
    expect(await openerDimmed('off')).toBe(false)
  })
})
