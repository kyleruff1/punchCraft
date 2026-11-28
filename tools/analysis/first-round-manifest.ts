/**
 * Generate the expected first-round audio manifest for a workout.
 *
 * Loop Stage 1 of the 10-Workout Audio Verification Loop
 * (see .claude/plans/it-s-time-to-build-linked-deer.md).
 *
 * Runs `compileWorkoutScore` on each requested sample and writes
 * `tools/analysis/manifests/<workoutId>.json` — the ground truth the
 * verifier correlates against.
 *
 * Usage (the stub loader makes the manifests' `require('…wav')` a
 * placeholder under Node — a bare `npx tsx` fails on the first wav):
 *   node --import ./tools/analysis/wav-stub.mjs --import tsx \
 *     tools/analysis/first-round-manifest.ts --workout=<id> [--vocab=techniques]
 *   node --import ./tools/analysis/wav-stub.mjs --import tsx \
 *     tools/analysis/first-round-manifest.ts --all [--vocab=techniques]
 *
 * Deterministic — same input produces byte-equal output.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileWorkoutScore } from '../../src/domain/programs/workoutScore'
import { runtimeCoachAssetResolver } from '../../src/audio/coachAssetResolvers'
import { bpmForRecipe } from '../../src/domain/workout/cadence'
import { coachPathOf } from '../../src/domain/workout/GeneratedWorkout'
import {
  getSampleWorkout,
  listSampleWorkouts,
  type SampleWorkoutKey,
} from '../../src/domain/workout/samples'
import { findComboAnnounceById } from '../../src/audio/voiceAssets/comboAnnounceManifest'
import { findCallClip } from '../../src/audio/voiceAssets/callClips'
import { findClickScript } from '../../src/audio/voiceAssets/clickScriptManifest'
import { TRANSPORT_TICKS_PER_PULSE } from '../../src/domain/timing/TimingEngine'
import { expandTimeline } from '../../src/domain/programs/CueTimeline'
import { planRoundCoachSchedule } from '../../src/domain/coach/roundCoachSchedule'
import { disciplineOf } from '../../src/domain/workout/discipline'
import {
  countdownOpeners,
  expectedRest,
  expectedWalkout,
  type ExpectedRest,
  type ExpectedWalkout,
} from './ceremony-plan'
import type {
  CompiledCoachSlot,
} from '../../src/domain/programs/workoutScore'

const MS_PER_TICK = 60_000 / (60 * TRANSPORT_TICKS_PER_PULSE)

// `import.meta.url` is empty when jest loads this file (the freshness test
// in `__tests__/manifests-fresh.test.js`), and jest runs from the repo root.
const REPO_ROOT = import.meta.url
  ? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  : process.cwd()
const MANIFESTS_DIR = join(REPO_ROOT, 'tools', 'analysis', 'manifests')

type ExpectedCoachEvent =
  | {
      kind: 'combo-announce'
      /**
       * The compiled slot's id, carried so the correlator can JOIN a
       * `workout.slotDispatcher.deferred` log line to the expectation it
       * suppressed. Without it a dropped combo-announce is indistinguishable
       * from one the app never tried to play (GH #305).
       */
      slotId: string
      cueId: string
      repId: string | null
      assetId: string
      text?: string
      durationMs?: number
      expectedStartTick: number
      expectedStartMs: number
      expectedEndTick: number
      expectedEndMs: number
      source: 'score.coachSlot'
    }
  | {
      /**
       * Script Bible v2 section lead-in (2026-09-01): a section's lead-in,
       * as `planRoundCoachSchedule` plans it — the function the runner
       * builds its schedule with. The expectation is that plan's own entry,
       * so the correlator checks that the device carried the plan out, not
       * a second derivation of it.
       */
      kind: 'lead-in'
      slot: string
      clipId: string
      text: string
      durationMs: number
      expectedStartTick: number
      expectedStartMs: number
      source: 'clickScript.schedule'
    }
  | {
      kind: 'per-word'
      cueId: string
      repId: string
      strikeIndex: number
      assetId: string
      expectedStartTick: number
      expectedStartMs: number
      source: 'announcer.per-word'
    }

interface FirstRoundManifest {
  workoutId: string
  workoutName: string
  /** Which click-script vocabulary the expectations priced (default numbers). */
  vocabulary: 'numbers' | 'techniques'
  /**
   * 2: the manifest holds every round, in `rounds`. A manifest without this
   * field is from before that and describes round 1 only, in top-level
   * `coachEvents` / `expectedCallBars` / `workDurationMs`; the verifier
   * reads both (`manifestRounds`).
   */
  formatVersion: 2
  bpm: number
  /**
   * Whole-session shape for the unattended suite (GH #292): verify-suite.mjs
   * sizes each drive's budget and the sim's pace from these, so it needs no
   * TypeScript at runtime.
   */
  roundCount: number
  scheduleMs: readonly { workMs: number; restMs: number }[]
  estimatedActivePunchesPerMinute: number
  compiledAtEpochMs: 0
  identity: {
    workoutId: string
    revision: number
    timelineHash: string
  }
  /**
   * What the coach should say in each round, in order.
   *
   * Every round holds the click path's expectations: its section lead-ins,
   * and how many per-bar calls the runner plans (counted, not itemized).
   * Round 1 also holds the score path's — combo-announces and per-word
   * calls — which no shipped workout produces; later rounds do not, because
   * the compiled score's ticks run on a whole-workout axis and nothing
   * needs them yet.
   */
  rounds: readonly ManifestRound[]
  /**
   * What is said around the rounds (`ceremony-plan.ts`): the walkout here,
   * and each rest's line and countdown on the round it follows. A manifest
   * without this is from before ceremonies had expectations, and the
   * verifier judges none.
   */
  ceremonies: {
    walkout: ExpectedWalkout | null
    /** The lines a countdown may open with, and how long each is. */
    countdownOpeners: Readonly<Record<string, number>>
  }
  silentByDesign: readonly {
    reason: string
    cueId: string
    spanTick: readonly [number, number]
    spanMs: readonly [number, number]
  }[]
  notes: readonly string[]
}

export interface ManifestRound {
  roundIndex: number
  workDurationMs: number
  restAfterMs: number
  coachEvents: readonly ExpectedCoachEvent[]
  /** Bars the runner plans a per-bar call for, in this round. */
  expectedCallBars: number
  /** The rest after this round: its line and its countdown. `null` after the last. */
  rest: ExpectedRest | null
}

function tickToMs(tick: number): number {
  return Math.round(tick * MS_PER_TICK)
}

function toExpectedCoachEvent(slot: CompiledCoachSlot): ExpectedCoachEvent | null {
  const preferred = slot.variants.numeric ?? slot.variants.technique
  if (!preferred) return null
  if (slot.contentKind !== 'combo-announce') return null
  const clip = findComboAnnounceById(preferred.assetId)
  return {
    kind: 'combo-announce',
    slotId: slot.slotId,
    cueId: slot.cueId,
    repId: slot.repId,
    assetId: preferred.assetId,
    ...(clip ? { text: clip.text, durationMs: clip.durationMs } : {}),
    expectedStartTick: preferred.audibleStartTick,
    expectedStartMs: tickToMs(preferred.audibleStartTick),
    expectedEndTick: preferred.audibleEndTick,
    expectedEndMs: tickToMs(preferred.audibleEndTick),
    source: 'score.coachSlot',
  }
}

export function buildFirstRoundManifest(
  workoutId: SampleWorkoutKey,
  // Mirrors the runner's per-round vocabulary snapshot: expectations must
  // price the SAME clips the runner will dispatch, or every technique
  // drive reads as uniformly early/late against numeric durations.
  vocabulary: 'numbers' | 'techniques' = 'numbers',
): FirstRoundManifest {
  const sample = getSampleWorkout(workoutId)
  const workout = sample.workout
  // Absent on every workout shipped today, which is boxing — see
  // `src/domain/workout/discipline.ts`.
  const discipline = disciplineOf(workout)
  const bpm = bpmForRecipe(workout.recipe)
  const compiled = compileWorkoutScore(workout, {
    stance: 'orthodox',
    bpm,
    revision: 1,
    compiledAtEpochMs: 0,
    coachAssets: runtimeCoachAssetResolver,
  })

  // Runtime plays combos two different ways depending on the cue's V1c
  // voicePolicy:
  //   - `announce-then-work` cues → SlotDispatcher fires a single
  //     combo-announce clip via score.coachSlots, ONCE for the block
  //     (the runner enqueues only `repeatIndex === 0`); the block's
  //     remaining reps are worked in silence.
  //   - `per-punch` and default cues → announcer's `announce()` fires
  //     a per-word phrase (playPhrase) that emits one standalone clip
  //     per PUNCH token, and `onTokenDue` may add per-token calls
  //     under `follow-the-call` / `in-time` styles.
  //
  // For the expected manifest we anchor per-word events to what the
  // ENGINE emits: `cue.scheduledStartMs + cue.tokenOffsetsMs[tokenIdx]`
  // — the exact wall-clock ms the runtime uses for its `token-due`
  // event. Actual observed timing may drift from this (playPhrase
  // schedules earlier than the strike beat; onTokenDue fires AT the
  // strike beat) — the correlator's match window absorbs that; the
  // key correctness invariant is "the right asset for the right
  // strike position at roughly the right moment", not exact-tick
  // matching.
  const timeline = expandTimeline(workout, 'orthodox', bpm)
  const round0 = timeline[0]
  // TWO sets, because `announce-then-work` means different things to the
  // two branches below and one set cannot serve both (GH #305).
  //
  // `expandBlock` mints one CueInstance PER REPETITION (`sp1-b4#0` …
  // `#9`), and every rep carries the block's voicePolicy. So:
  //
  //   - Only the rep-0 cue is ANNOUNCED. The runner enqueues score slots
  //     under `voicePolicy === 'announce-then-work' && repeatIndex === 0`
  //     (_useWorkoutRunner.ts, commit 28db740) — speak the combination
  //     once at block start, not once per rep. Expecting a slot per rep
  //     produced 23 speed-combos expectations against 5 real dispatches,
  //     i.e. a guaranteed hard FAIL that had nothing to do with the app.
  //
  //   - But EVERY rep is silent on the per-word path. Interior reps are
  //     authored silence: `CueAnnouncer` early-returns for them. Letting
  //     rep>0 cues fall through to the per-word branch would mint ~50
  //     phantom per-word expectations per workout — which is why the
  //     one-line fix of just narrowing the single set is wrong.
  const atwAnnounceCueIds = new Set<string>()
  const atwCueIds = new Set<string>()
  if (round0) {
    for (const cue of round0.cues) {
      if (cue.voicePolicy !== 'announce-then-work') continue
      atwCueIds.add(cue.id)
      if (cue.repeatIndex === 0) atwAnnounceCueIds.add(cue.id)
    }
  }

  const roundOneAtwSlots = compiled.coachSlots
    .filter((s) => s.roundIndex === 0 && atwAnnounceCueIds.has(s.cueId))
    .slice()
    .sort((a, b) => a.reservationStartTick - b.reservationStartTick)
  const coachEvents: ExpectedCoachEvent[] = []
  for (const slot of roundOneAtwSlots) {
    const ev = toExpectedCoachEvent(slot)
    if (ev) coachEvents.push(ev)
  }
  // MVP v2 (GH #305): on a click-track set the announcer is capped below
  // punch calls — the click script speaks them — so there are no per-word
  // expectations to correlate. Emitting them anyway would hard-FAIL every
  // click set on audio it is designed not to produce. Keyed on the
  // workout's authored coach path, the same field the runner reads.
  const clickScriptWorkout = coachPathOf(workout) === 'click-script'
  if (round0 && !clickScriptWorkout) {
    for (const cue of round0.cues) {
      if (atwCueIds.has(cue.id)) continue
      for (let i = 0; i < cue.tokens.length; i += 1) {
        const token = cue.tokens[i]!
        if (token.kind !== 'punch') continue
        const assetId = token.body ? `${token.number}b` : `${token.number}`
        const expectedStartMs =
          cue.scheduledStartMs + (cue.tokenOffsetsMs[i] ?? 0)
        coachEvents.push({
          kind: 'per-word',
          cueId: cue.id,
          repId: 'rep-0',
          strikeIndex: i,
          assetId,
          expectedStartTick: Math.round(expectedStartMs / MS_PER_TICK),
          expectedStartMs,
          source: 'announcer.per-word',
        })
      }
    }
  }
  // The round's own schedule — its section lead-ins and its per-bar calls —
  // from the SAME function the runner builds it with
  // (`planRoundCoachSchedule`). It used to be restated here, and the
  // restatement drifted twice. It anchored a lead-in to the section's first
  // strike, about two seconds after the call the runner anchors it to. And
  // it worked out each call's window with arithmetic of its own — the bar's
  // start, less the clip, less a 100 ms pad the app replaced in September —
  // so it pruned calls against a lead-in that the runner keeps:
  // `expectedCallBars` was one to three short of what the runner sends in
  // 20 of the 44 manifests, and a round could lose that many calls and still
  // pass the coverage check (findings doc, N-20).
  //
  // Section 1 has no in-round lead-in — the walkout or the countdown names
  // it before the bell — so the plan holds none and none is expected.
  const planFor = (roundIndex: number) => {
    const round = timeline[roundIndex]
    return round
      ? planRoundCoachSchedule({
          workoutId: workout.id,
          roundIndex,
          cues: round.cues,
          vocabulary,
          findCall: (motif) => findCallClip(motif, vocabulary, discipline),
          findLeadIn: (slot) => findClickScript(slot, vocabulary),
        })
      : null
  }
  /** A round's lead-ins as expectations, and the number of calls it plans. */
  const clickPath = (roundIndex: number): { leadIns: ExpectedCoachEvent[]; calls: number } => {
    const plan = planFor(roundIndex)
    const leadIns: ExpectedCoachEvent[] = []
    for (const entry of plan?.entries ?? []) {
      if (entry.kind !== 'lead-in') continue
      leadIns.push({
        kind: 'lead-in',
        slot: entry.slot,
        clipId: entry.clip.id,
        text: entry.clip.text,
        durationMs: entry.clip.durationMs,
        expectedStartTick: Math.round(entry.dispatchAtMs / MS_PER_TICK),
        expectedStartMs: entry.dispatchAtMs,
        source: 'clickScript.schedule',
      })
    }
    // Per-bar calls are counted, not itemized: some seventy near-identical
    // expectations a round would bury the report. The count is the plan's —
    // the calls the runner will send, rep-0 calls included.
    return { leadIns, calls: plan ? plan.entries.filter((entry) => entry.kind === 'call').length : 0 }
  }
  const rounds: ManifestRound[] = workout.schedule.map((scheduled, roundIndex) => {
    const click = clickPath(roundIndex)
    // Round 1 keeps the score path's expectations built above; the click
    // path's are every round's.
    const events = [...(roundIndex === 0 ? coachEvents : []), ...click.leadIns]
    events.sort((a, b) => a.expectedStartTick - b.expectedStartTick)
    return {
      roundIndex,
      workDurationMs: scheduled.workDurationMs,
      restAfterMs: scheduled.restAfterMs,
      coachEvents: events,
      expectedCallBars: click.calls,
      rest: expectedRest(workout, roundIndex, vocabulary),
    }
  })
  const notes: string[] = []
  if (workoutId === 'pump-and-coast') {
    notes.push(
      'Pump & Coast pump / coast blocks are DELIBERATELY coach-silent — sustained + coast runtime consumers not yet wired. silentByDesign is TBD until the manifest generator learns to detect those block spans (Slice 6).',
    )
  }
  return {
    workoutId: sample.key,
    workoutName: sample.name,
    vocabulary,
    formatVersion: 2,
    bpm,
    roundCount: workout.schedule.length,
    scheduleMs: workout.schedule.map((round) => ({
      workMs: round.workDurationMs,
      restMs: round.restAfterMs,
    })),
    estimatedActivePunchesPerMinute: workout.estimatedActivePunchesPerMinute,
    compiledAtEpochMs: 0,
    identity: {
      workoutId: compiled.identity.workoutId,
      revision: compiled.identity.revision,
      timelineHash: compiled.identity.timelineHash,
    },
    rounds,
    ceremonies: {
      walkout: expectedWalkout(workout, vocabulary),
      countdownOpeners: countdownOpeners(),
    },
    silentByDesign: [],
    notes,
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

function writeManifest(manifest: FirstRoundManifest): string {
  ensureDir(MANIFESTS_DIR)
  // Technique-vocabulary manifests live beside the numeric ones under a
  // suffixed name — the numeric file stays the canonical default the
  // existing drives load.
  const suffix = manifest.vocabulary === 'techniques' ? '.techniques' : ''
  const outPath = join(MANIFESTS_DIR, `${manifest.workoutId}${suffix}.json`)
  ensureDir(dirname(outPath))
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return outPath
}

function summarize(m: FirstRoundManifest): string {
  return [
    `${m.workoutId} (${m.workoutName})`,
    `  ${m.bpm} bpm · hash=${m.identity.timelineHash} · ${m.roundCount} rounds · ${m.estimatedActivePunchesPerMinute}/min`,
    ...m.rounds.map(
      (r) =>
        `  round ${r.roundIndex + 1} · ${r.workDurationMs / 1000}s · coachEvents=${r.coachEvents.length} · calls=${r.expectedCallBars}`,
    ),
    ...(m.notes.length > 0 ? [`  notes:`, ...m.notes.map((n) => `    - ${n}`)] : []),
  ].join('\n')
}

function parseArgs(argv: string[]): {
  all: boolean
  workouts: SampleWorkoutKey[]
  vocabulary: 'numbers' | 'techniques'
} {
  const all = argv.includes('--all')
  const workoutArg = argv.find((a) => a.startsWith('--workout='))
  const single = workoutArg?.slice('--workout='.length) as SampleWorkoutKey | undefined
  const vocabArg = argv.find((a) => a.startsWith('--vocab='))?.slice('--vocab='.length)
  const vocabulary = vocabArg === 'techniques' ? ('techniques' as const) : ('numbers' as const)
  if (vocabArg !== undefined && vocabArg !== 'numbers' && vocabArg !== 'techniques') {
    throw new Error(`--vocab must be numbers or techniques, got '${vocabArg}'`)
  }
  if (all && single) {
    throw new Error('Pass either --all or --workout=<id>, not both.')
  }
  if (!all && !single) {
    throw new Error(
      'Usage: npx tsx tools/analysis/first-round-manifest.ts (--all | --workout=<id>) [--vocab=techniques]',
    )
  }
  if (all) {
    return {
      all: true,
      workouts: listSampleWorkouts().map((s) => s.key),
      vocabulary,
    }
  }
  return { all: false, workouts: [single as SampleWorkoutKey], vocabulary }
}

function main(): void {
  const argv = process.argv.slice(2)
  const { workouts, vocabulary } = parseArgs(argv)
  for (const key of workouts) {
    const manifest = buildFirstRoundManifest(key, vocabulary)
    const outPath = writeManifest(manifest)
    console.log(summarize(manifest))
    console.log(`  wrote ${outPath}`)
  }
}

// Only run when invoked directly (not on import).
const invokedDirectly = process.argv[1]?.endsWith('first-round-manifest.ts')
if (invokedDirectly) {
  main()
}
