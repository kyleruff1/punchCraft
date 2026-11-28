# Beat Mapping & Offset Strategy — Operational Reference

# Beat Mapping & Offset Strategy — Operational Reference

Repo root `F:/punchCraft`. Last commit `8b7e79a2` (2026-09-26). All paths below are repo-relative; prefix with `F:/punchCraft/`. Every number was read out of the file cited, not recalled.

**Read this first:** the task brief that generated this document contains a wrong example. There is no `LEAD_IN_PAD_MS = 282` and no such constant in `VoicePolicy.ts`. The real constant is `LEAD_IN_PAD_MS = 250` at `src/domain/coach/callPlacement.ts:38`. 282 existed briefly (commit `ea5df336`) and was reverted in `1af8a232`. See §3.3.

---

## 1. The canonical time grid

There are **four** clocks. Conflating any two of them is the single largest source of historical bugs in this subsystem.

| # | Clock | Unit | Lives in | Who reads it |
|---|---|---|---|---|
| 1 | **`workElapsedMs`** — THE authority clock | ms, round-relative, float | `src/domain/session/WorkoutSessionClock.ts` | `CueEngine.tick`, `CueAnnouncer.onTick`, click-script dispatch, `scoreTickAt`, `SharedWorkClock` |
| 2 | **Score / transport tick axis** | integer ticks @ 960/pulse @ 60 BPM, **cumulative across rounds** | `src/domain/timing/TimingEngine.ts` + `src/domain/programs/workoutScore.ts` | `compileCue`, `workoutScore`, `SlotDispatcher` |
| 3 | **Metronome transport tick** | absolute ticks, re-zeroed on every `start()` | `src/audio/MetronomeTransport.ts` | `SharedTransportAnchor` → avatar flip clock only |
| 4 | **Monotonic clock** | ms, arbitrary origin | `src/domain/time/MonotonicClock.ts` | `*ActualMs` stamps, suspension spans, log `monotonicTimeMs`. **Never** used to decide whether a cue is due. |

### 1.1 `workElapsedMs` — the one authority

`src/domain/session/WorkoutSessionClock.ts`

```ts
advance(): SessionTransition[] {
  const now = this.clock.now()
  if (this.lastAdvanceAtMs === null) { this.lastAdvanceAtMs = now; return [] }
  const delta = Math.max(0, now - this.lastAdvanceAtMs)
  this.lastAdvanceAtMs = now
  // Paused and terminal phases accumulate nothing — this is what freezes
  // the work clock rather than any offset arithmetic.
  if (delta === 0 || !this.isRunning()) return []
  this.phaseElapsedMs += delta
  if (this.phase === 'work') this.workElapsedMs = this.phaseElapsedMs   // :130
  …
}
```

- `advance()` at `:116-145`. `pause()` `:146`, `resume()` `:154-159` (sets `lastAdvanceAtMs = now` so the paused span is **discarded, never accumulated**).
- `enterWork(roundIndex, overflowMs = 0)` at `:255-261` sets **both** `phaseElapsedMs` and `workElapsedMs` to the phase overflow.
- `DEFAULT_COUNTDOWN_MS = 5_000` at `:66`.
- Because a pause accumulates nothing, **no component anywhere does pause-offset arithmetic**. This is a settled, do-not-re-litigate decision.
- Snapshot field doc at `:49-57`: "Holds its last value through a pause and resets at the start of each round."

The runner samples it **once per tick** and hands that one sample to everything (`src/app/(tabs)/punchcraft/_useWorkoutRunner.ts:2003-2042`):

```
session.advance() → applyTransitions(transitions) → pushStore(true)
snapshot = session.snapshot()
announcer.onRoundClock(snapshot.phaseRemainingMs)
workElapsedMsRef.current = snapshot.workElapsedMs
viz.tick(snapshot.workElapsedMs)            // sampled BEFORE engine.tick, so a stall
engine.tick(snapshot.workElapsedMs)         //   is blamed on the gap, not the burst
announcer.onTick(snapshot.workElapsedMs, clock.now())
slotDispatcher.advance(scoreTickAt(roundStartTicks, snapshot.workElapsedMs, snapshot.roundIndex), snapshot.roundIndex)
<click-script lead-in / call dispatch loop>  // :2047-2130
<metronome swap loop>                        // :2131-2155
voice.output.advance(); syncFromEngine(); pushStore(false); viz.flush()
```

`viz.flush()` is **last** by design — instrumentation must never sit inside the window it measures.

### 1.2 The tick axis — `TRANSPORT_TICKS_PER_PULSE = 960`

`src/domain/timing/TimingEngine.ts:66` (`as const`).

```
960 / division  →  1:960  2:480  3:320  4:240 ticks per strike unit
AUTHORING_STEPS_PER_PULSE = 12          (TimingEngine.ts:76)
TICKS_PER_AUTHORING_STEP  = 960/12 = 80 (TimingEngine.ts:79)
```
V1c shipped `TICKS_PER_PULSE = 12`; too coarse for the ±10–15 ms fit check. **No other file may hardcode 12 or 960** — the header says so explicitly.

Live helpers: `ticksPerUnit(division)` (`:97`, throws outside 1..4), `tickDurationMs(baseBpm)` (`:106`), `tickAt(elapsedMs, baseBpm)` (`:113`), `msAtTick(tick, baseBpm)` (`:117`), `tickAtAuthoringStep(step)` (`:126`).

`MS_PER_TRANSPORT_TICK = 60_000 / (60 * 960) = 1.0416666…` ms is defined **independently three times**:
- `src/domain/programs/programCueBridge.ts:85` (`MS_PER_TRANSPORT_TICK`, `ticksAtMs` at `:91-93`)
- `src/domain/programs/workoutScore.ts:76` (`MS_PER_TRANSPORT_TICK`, `ticksAtMs` at `:82-84`)
- `src/domain/programs/scoreClock.ts:29` (named `MS_PER_SCORE_TICK`)

All three round with `Math.round`. All three hardcode `BASE_BPM = 60` (`programCueBridge.ts:82`, `workoutScore.ts:75`).

### 1.3 Divisions = one clock, four subdivisions

`TimingEngine.ts:4-17` (table verbatim), at `baseBpm 60`:

| Profile | Division | Interval | Call slots/min |
|---|---|---|---|
| Technical | 1/beat | 1,000 ms | 60 |
| Steady | 2/beat | 500 ms | 120 |
| Pressure | 3/beat | 333 ms | 180 |
| Sprint | 4/beat | 250 ms | 240 |

Density is explicitly **separate from rate** (`:21-31`): a 240-slot grid means 240 *possible positions*, actual pace = slots/min × occupancy.

### 1.4 Worklet mirrors of clocks 1 and 3

`src/domain/timing/SharedWorkClock.ts` — mirror of **the session clock**:
```ts
sharedWorkElapsedMs(clock, frameTimestampMs) =
  clock.running ? clock.workElapsedAtPublishMs + (frameTimestampMs - clock.publishFrameTimestampMs)
                : clock.workElapsedAtPublishMs          // :66-76
SHARED_WORK_CLOCK_STOPPED = { roundIndex: -1, workElapsedAtPublishMs: 0, publishFrameTimestampMs: 0, running: false }  // :55
```
The `'worklet'` directive is **inside** the function at `:73` and is load-bearing (`:67-72`: without it you get `[Worklets] Tried to synchronously call a Remote Function on the UI Runtime` — instant red screen, invisible to jest).

Published only at discontinuities, inside `applyTransitions`, at `_useWorkoutRunner.ts:1517-1528`:
```ts
args.workClock.value = Object.freeze({
  roundIndex: s?.roundIndex ?? -1,
  workElapsedAtPublishMs: s?.workElapsedMs ?? 0,
  publishFrameTimestampMs: performance.now(),   // falls back to Date.now()
  running: s?.phase === 'work',
})
```
`running` is `phase === 'work'` **only**. Frame-timestamp domain = `performance.now()`.

`src/domain/timing/SharedTransportAnchor.ts` — mirror of **the metronome transport**, not the session clock (`SharedWorkClock.ts:10-16` says why):
```ts
sharedAnchorCurrentTick(anchor, frameTimestampMs) =
  anchor.running ? anchor.anchorTick + (frameTimestampMs - anchor.anchorFrameTimestampMs) * anchor.ticksPerMillisecond
                 : anchor.anchorTick                    // :131-139
ticksPerMillisecondFor(baseBpm) = baseBpm * 960 / 60_000   // :172-175
```
Here the `'worklet'` directive is at `:135` *inside* `sharedAnchorCurrentTick`, but the module header (`:112-116`) says for this helper the directive **lives at the CALL SITE**. Treat the placement as per-function and verified, not inferable.

---

## 2. beatOffset → milliseconds

### 2.1 The conversion

`src/domain/workout/cadence.ts`
```ts
beatsToMs(beats, bpm) = (beats * 60_000) / bpm        // :66-68
msToBeats(ms, bpm)    = (ms * bpm) / 60_000           // :71-73
tokenOffsetsMs(tokens, bpm) = tokens.map(t => beatsToMs(t.beatOffset, bpm))   // :81-83  index-preserving
maxBeatOffset(tokens)  = max beatOffset, 0 for empty  // :86-88
blockDurationMs(tokens, gapBeats, bpm) = beatsToMs(maxBeatOffset(tokens) + gapBeats, bpm)  // :98-104
```
`beatsToMs` returns **fractional** ms deliberately (`:60-64`): rounding here accumulates over a 3-minute round; callers round once at the scheduling/display edge.

`gapBeats` is the **trailing** gap and belongs to the block that precedes it (D5, `:90-97`) — that is what keeps laid blocks non-overlapping.

### 2.2 Cadence profiles

`cadence.ts:51-56`
```ts
technical: { minBpm: 80,  maxBpm: 90,  nominalBpm: 85  }
steady:    { minBpm: 95,  maxBpm: 110, nominalBpm: 100 }
pressure:  { minBpm: 110, maxBpm: 130, nominalBpm: 120 }
sprint:    { minBpm: 130, maxBpm: 150, nominalBpm: 140 }
```
`clampToProfile(bpm, profile)` at `:147-151`, idempotent, the hard stop for PacingEngine's ±10–15%.

### 2.3 `bpmForRecipe` — the single tempo seam

`cadence.ts:131-136`
```ts
export function bpmForRecipe(recipe: WorkoutRecipe): number {
  if (recipe.metronome.enabled) {
    return recipe.coachTempo.baseBpm * recipe.coachTempo.division * recipe.globalSpeed
  }
  return CADENCE_PROFILES[recipe.cadenceProfile].nominalBpm
}
```
Every compiler (`expandTimeline`, `compileWorkoutScore`, `compileWorkoutScript`) takes "just a bpm".

### 2.4 ⚠ The "60 BPM master pulse" doctrine is NOT what runs

Verified across the shipped samples:

| Sample | `coachTempo` | CLICK_MAP `bpm` | `bpmForRecipe` |
|---|---|---|---|
| `bodyWork`, `establishTheJab20`, `progressiveBuildup`, `pumpAndCoast`, `switchByRound`, `uppercutClinic` | `{ baseBpm: MAP.bpm, division: 1, swing: 0.5 }` | 100 / 100 / 100 / 100 / 85 / 85 | 100 / 85 |
| `threeRoundFundamentals`, `heavyHands`, `pacePusher`, `speedCombos` | `{ baseBpm: 60, division: 2, swing: 0.5 }` | 120 | 120 (60×2, by coincidence) |
| 12 quick workouts | `clickTempoFor(bpm)`, `samples/composeFromChunks.ts:73-78`: `bpm === 120 ? {60, 2} : {bpm, 1}` | 85/100/120 | same |

All of them set `metronome: { enabled: true, volume: 0.6 }` and `voiceMode: 'minimal'`.

So **"bpm" means two different things in one subsystem**: the *visual/ring grid* runs at 85/100/120, while `compileCue` / `workoutScore` / `programCueBridge` hardcode `BASE_BPM = 60` for the *tick axis*. `clickTempoFor`'s own comment (`composeFromChunks.ts:68-71`) states it: "TEMPO SCALES BY DIVISION, never baseBpm. Any other bpm has no loop in the bank and would fail the metronome-asset lookup on glass."

### 2.5 ⚠ Three separate bpm values reach the audio layer per workout

`_useWorkoutRunner.ts:1456-1491` `startMetronome()`:
- **Loop WAV** chosen by `metronomeLoopFor(division, swing, baseBpm)` → `coachTempo.baseBpm`
- **Transport rate** passed as `port.start(loop, clickVolume, bpmForRecipe(workout.recipe))` (`:1490`) → `baseBpm × division × globalSpeed`

`MetronomeTransport.start(baseBpm)` (`src/audio/MetronomeTransport.ts:150-166`) then sets `ticksPerSecond = baseBpm * 960 / 60`, bumps `generation`, resets `anchorAbsoluteTick = 0`.

Consequence for `threeRoundFundamentals` et al.: a **60-BPM loop WAV (1000 ms bar)** plays under a **120-BPM tick clock**. The avatar flip clock rides `SharedTransportAnchor`, i.e. the 120-BPM rate. `src/audio/wrappedPositionToAbsoluteTick.ts` is only correct while JS↔audio skew < half a loop. This mismatch class is exactly what produced "~500 holds/sec" in `correct()` (§5.3).

### 2.6 Click-map measure arithmetic (where authored offsets come from)

`src/domain/workout/samples/clickMaps.ts`
```ts
measuresPerRep(slots, rate)  // :82-85   slots 8 → rate 1 ? 3 : 1.5 ;  slots 4 → rate 1 ? 2 : 1
breathBeats(slots, rate) = measuresPerRep(slots, rate) * 4 - slots / rate   // :88-90
rowMeasures(row) = measuresPerRep(slotCount(motif), rate) * reps            // :93-95
SETUP_GAP_MEASURES = 2                                                      // :104
setupMeasuresForRow(row, i) = row.setupMeasures ?? (i > 0 ? 2 : 0)          // :113-115
```
`clickSpecs(prefix, roundIndex, round)` at `:118-143`:
```ts
const step = 1 / row.rate
offsets  = Array.from({ length: slots }, (_, k) => k * step)
gapBeats = breathBeats(slots, row.rate) + step        // :138  — the "+ step" is load-bearing
leadInBeats = setupM * 4
```
Comment at `:132-136`: *"The laid rep span is lastOffset + gapBeats — measured to the last punch's ONSET, not the end of its slot — so the gap must carry the final slot's width (1/rate)… Caught 2026-09-02: rounds under-filled ~12% and ended ~30 s of dead air before the bell."*

Stride table verbatim from the header (`:25-32`): 4-slot@1x = 2 m/rep, 4-slot@1.5x = 1 m, 4-slot@2x = 1 m, 8-slot@1x = 3 m, 8-slot@2x = 1.5 m. Caps: `MAX_BURST_PUNCHES_PER_SEC = 4` (`:150`), `MAX_SUSTAINED_PUNCHES_PER_SEC = 2.5`.

### 2.7 Where beats become ms, once

`src/domain/programs/CueTimeline.ts` → `expandTimeline(workout, defaultStance, bpm, options)`. Header `:4-8`: *"**All** beat math, stance resolution, repeat expansion and window clamping happen here, once, at load — after this, the engine and the matcher work in plain milliseconds and never think about beats again."*

`expandBlock` at `:350-436`:
```ts
offsets     = tokenOffsetsMs(block.tokens, ctx.bpm)
comboSpanMs = beatsToMs(maxBeatOffset(block.tokens), ctx.bpm)
gapMs       = beatsToMs(block.gapBeats, ctx.bpm)
repeats     = Math.max(1, block.repeat ?? 1)
// per repeatIndex:
scheduledStartMs = block.startOffsetMs + repeatIndex * (comboSpanMs + gapMs)
scheduledEndMs   = scheduledStartMs + comboSpanMs
```
The timeline is `useMemo`'d on `[workout, stance, bpm]` and `expandTimeline` is **never re-run mid-session**.

---

## 3. Every named offset / pad / floor constant

### 3.1 Cue lead times (`src/domain/programs/CueTimeline.ts`, `CueEngine.ts`)

| Constant | Value | file:line | Why |
|---|---|---|---|
| `DEFAULT_PREVIEW_LEAD_MS` | `1_500` | `CueTimeline.ts:43` | Doc §18.3: next combination appears dimmed at T−1.50 s. `previewAt = Math.max(0, start - previewMs)` |
| `DEFAULT_ANNOUNCE_LEAD_MS` | `750` | `CueTimeline.ts:45` | Doc §18.3: voice speaks the combination at T−0.75 s. `announceAt = Math.max(0, start - announceMs)` |
| `DEFAULT_LEAD_TIMES` | `{ previewMs: 1_500, announceMs: 750, readyToneMs: 100 }` | `CueEngine.ts:53-57` | Doc §18 defaults |
| `DEFAULT_BURST_COUNTDOWN_MS` | `3_000` | `CueTimeline.ts:208` | Lead-in before a burst starts counting, so the first second isn't spent reacting |

`readyToneMs: 100` fires a `cue-ready` event but **no tone is ever compiled**. `RhythmMap` refuses ready tones ("no beeps, ever"). It survives only as the quiet margin a phrase must finish inside — used as `finishBy = cue.scheduledStartMs - leadTimes.readyToneMs` (`RhythmMap.ts:403`).

Both `previewAt` and `announceAt` are **floored at 0, not widened** (`CueTimeline.ts:393-396`): "a cue right at the bell simply gets a shorter preview."

### 3.2 Avatar / ring / store / swap leads (`src/app/(tabs)/punchcraft/_useWorkoutRunner.ts`)

| Constant | Value | line | Why |
|---|---|---|---|
| `TICK_INTERVAL_MS` | `50` | `:94` | "fine enough that a cue fires within a frame of its time". Measured on-tablet it actually fires at **~150–341 ms** under load. |
| `PREVIEW_LEAD_REPS` | `2` | `:123` | Kyle 2026-09-04: preview should lead in with the section's whisper, not flash in on the final rep |
| `METRONOME_SWAP_LEAD_MS` | `400` | `:134` | Loop swap tears down + rebuilds the native playlist (~50-200 ms); must land inside the punch-free setup gap. A 2-measure gap is ≥4000 ms @120 / ≥5600 ms @85 |
| `AVATAR_LEAD_MS` | `375` | `:217` | Tuned **750 → 375** on-glass 2026-09-02. At 750 the figure struck slightly before the calls on transitions; 375 lands him **125 ms AFTER each loop call ends**. Next stop on the dial if transitions still read early: **250** (= `LEAD_IN_PAD_MS`, lead-in-end exact) |
| `STORE_THROTTLE_MS` | `250` | `:226` | Was 100 (spec §15.3's 10 Hz). The 10 Hz re-render churn starved the JS responder system → Pressables dead during work |
| `RECENT_EVENT_WINDOW` | `256` | `:232` | How many recent punch events stay resolvable when a cue settles |

`audibleDivisionForSlot(slotMs, baseBpm)` at `:163-180`: picks the **coarsest** rendered division whose click interval divides `slotMs` a whole number of times, tolerance `Math.abs(perSlot - nearest) < 0.06`. Returns `undefined` → caller falls back to the recipe's division.

`maskedBarIds(cues, calledCueIds, guided, bpm)` at `:196-214`, presentation-only ("lit = spoken"). `measureMs = 240000 / bpm`; the first 2 measures of punching in every round stay dim; `-1 ms` float guard on the window edge.

### 3.3 Call / lead-in placement — `src/domain/coach/callPlacement.ts`

This file is **the** file for runtime coach timing on all 22 shipped workouts. 327 lines, ~60% mic-measurement provenance in comments. It lives under `src/domain` (Rule 2 purity) so the runner, the domain tests **and** the Node analysis tools import the same numbers. `_useWorkoutRunner.ts:102-115` re-exports every symbol, so there is exactly one definition.

| Constant | Value | line | Why |
|---|---|---|---|
| `LEAD_IN_PAD_MS` | `250` | `:38` | Breath between a section lead-in's last word and its section's first strike (Script Bible v2). The 50 ms tick granularity eats into it, never past it. |
| `CALL_PAD_MS` | `500` | `:47` | Kyle on-glass 2026-09-02: the previous **100 ms** pad "creates pressure". *"the pad is the target, the busy check the law."* |
| `CALL_DISPATCH_LAG_MS` | `71` | `:76` | = **46.5 ms** median scheduler lateness (`clickScript.dispatch.lateMs`) + **25.0 ms** median `play()`→first audio, over 46 release-build call bars. Deliberately **NOT** the raw 201 ms "observed end − planned end": 113 ms of that was the END EVENT arriving late, not audio playing long (manifest `durationMs` matches every wav to within 0.5 ms; excess varied by player path 124/94/67 ms). Correcting for reporting lag would have pushed every call ~130 ms too early. Validated on untuned content 2026-09-07: quick-six-count 85 bars + quick-speed-burst 185 bars, per-slot shortfall −15 to +49 ms. |
| `TECHNIQUE_CALL_LEAD_MS` | `250` | `:91` | Pulled back from 500 (Kyle: "too early" — at 500 the call ended ~1 s before the shot: body-work +1053, uppercut +984, speed-combos +1091 mean, 0 late). At 250 the tightest set stays never-late (~+195 worst). "we need a quarter-second delay." |
| `TECHNIQUE_LEADIN_LEAD_MS` | `500` | `:94` | Lead-ins keep the original lead — not part of the "too early" complaint |
| `NUMBERS_CALL_LEAD_MS` | `100` | `:104` | Numbers were already tight (~525 ms breath, liked) but had one marginal late (−31 ms worst on `1-2b-3b-2`). Nudge takes worst −31 → +69. Numbers **lead-ins** stay at 0. |
| `DENSE_BREATH_MS` | `{ numbers: 600, techniques: 750 }` | `:119-122` | Derived as `CALL_PAD_MS + <vocab> call lead`. The mic-tuned **UPPER** bound; a dense bar exits `breathForBar` with exactly these, unchanged. |
| `BREATH_REF_SLOT_MS` | `300` | `:125` | Inter-node interval the dense breath was tuned at (dense combos run ~250-333 ms slots) |
| `BREATH_TRACK_GAIN` | `1.0` | `:128` | How hard breath shrinks per ms `slotMs` exceeds the reference |
| `MIN_BREATH_MS` | `150` | `:131` | Kyle's comfort target — the call finishes at least this far before the first shot on the widest/slowest bars |
| `DELIVERED_BREATH_SHORTFALL_MS` | `95` | `:194` | See below |
| `CALL_BREATH_OVERRIDES` | `{ 'call/1-.-.-.': 340, 'call/1-.-2-.': 340 }` | `:232-235` | See below |

#### `DELIVERED_BREATH_SHORTFALL_MS = 95` — the full story (`:133-194`)

`PlaybackObserver` stamps a play's onset at `playbackStatusUpdate playing: true`. Across two full release sessions that event carried `positionAtOnsetMs: 0` in **296 of 296** observations — media3 asserts "playing" with the playhead still at zero, on a buffer floored at 250 ms. Timing one play two ways at once (`src/app/dev/voice-latency.tsx` "Calibrate ruler", release `73f7ea6f`, TB125FU, armed path, 40 reps/asset):

```
call cc-e08318c0 (48 kHz)  status 25.2  playhead 118.8  skew  95.4
bell             (24 kHz)  status 19.2  playhead 119.1  skew 101.4
```

So `MIN_BREATH_MS = 150` was a lie at the ear. Recomputed per bar, **8-15 % of bars** in tighter workouts delivered under the floor, worst at **57 ms**, and one pre-lag-fix capture put a call **ON** the punch (−7.5 ms).

Used **ONLY** in `breathForBar`'s lower clamp, and that restriction is the whole design:
- NOT added to `CALL_DISPATCH_LAG_MS` — that would move every dense bar 95 ms earlier, back toward the setting Kyle rejected as "too early". *His ear tuned the DELIVERED state, not the intended one.*
- NOT added to `DENSE_BREATH_MS` / `CALL_PAD_MS` / the lead constants — all mic-tuned.

Net effect: the clamp starts biting at `slotMs > 655` (numbers) / `> 805` (techniques) rather than 750/900.

**95 → 127 → 95 (reverted).** Bumping to 127 paired with `LEAD_IN_PAD_MS 250 → 282` (`ea5df336`, `0cbb3e18`) cleared the target `quick-coast-reset call/1-.-2-.` r0 −3.9 ms bar and improved under-floor rates, but the full 24-workout suite (release `ea5df336`, sha `1789073388672`) showed cross-workout regressions: `quick-uppercut-lane` **−113.5 ms** on `call/1-2-5-2` r0 (was 0.4 ms of margin pre-fix), `establish-the-jab-20` **−32.5 ms** on `call/1-2-1b-2` r2, `switch-by-round` **−24.7 ms** on `call/1-1-2-.` r0, plus a tokenDue disagreement 342 ms. **4 FAIL / 1 ERROR / 17 WARN / 0 PASS.** Reverted in `1af8a232`. *"the ruler was right for the median, wrong for the tail."*

**Rule: do not re-tune either as a global constant. Use `CALL_BREATH_OVERRIDES`.**

#### `CALL_BREATH_OVERRIDES` — the one per-slot escape hatch (`:196-235`)

A value here **replaces the whole formula**. Two live entries, both 340, both coast bars (Kyle 2026-09-11, closes GH #368 via the cross-workout-safe path per #385):

Both share one failure mode: the formula floors them at `MIN + SHORTFALL = 245 ms` because their inter-punch spacing (`Infinity` / 1200 ms) collapses the density term. At 245 ms scheduled, the fresh/cold-load tail eats the whole breath. Observed drift across four consecutive drives: `1-.-2-.` r0 was −3.9 pre-fix; `1-.-.-.` r0 drifted **97 → 36 → 10.8 → −27.8**. 340 buys ~95 ms above the floor, against an observed fresh-path tail max of **~305 ms** (~35 ms worst-case margin, ~130 ms typical).

Cross-workout safety: these slot keys appear in `quick-coast-reset` and `pump-and-coast` **only**. Every workout that regressed under the global shortfall bump uses different slot keys.

#### The breath formula (`:250-276`)

```ts
export function breathForBar(cue, vocabulary, slot) {
  const punchIdx = indexes where t.kind === 'punch'
  const firstPunchOffsetMs = punchIdx.length > 0 ? cue.tokenOffsetsMs[punchIdx[0]] ?? 0 : 0
  const dense = DENSE_BREATH_MS[vocabulary]
  const override = CALL_BREATH_OVERRIDES[slot]
  if (override !== undefined) return { breathMs: override, firstPunchOffsetMs }
  const slotMs = punchIdx.length >= 2
    ? (cue.tokenOffsetsMs[punchIdx[1]] ?? 0) - firstPunchOffsetMs
    : Number.POSITIVE_INFINITY
  const breathMs = Math.max(
    MIN_BREATH_MS + DELIVERED_BREATH_SHORTFALL_MS,                                  // = 245
    Math.min(dense, dense - BREATH_TRACK_GAIN * Math.max(0, slotMs - BREATH_REF_SLOT_MS)),
  )
  return { breathMs, firstPunchOffsetMs }
}
```
Anchored to the **first PUNCH, not bar start** — a bar may open on a rest.

Worked values (numbers, dense = 600): `slotMs 300 → 600`, `400 → 500`, `600 → 300`, `≥655 → 245`. These are exactly the `intended` column values seen in live reports (§7.3). Breath **shrinks** as the bar gets slower/wider; dense bars are unchanged to the millisecond.

#### Dispatch placement (`:286-327`)

```ts
callDispatchAtMs({ cue, scheduledStartMs, vocabulary, slot, clipDurationMs }) {
  const { breathMs, firstPunchOffsetMs } = breathForBar(cue, vocabulary, slot)
  const firstNodeMs = scheduledStartMs + firstPunchOffsetMs
  return { dispatchAtMs: Math.max(0, firstNodeMs - clipDurationMs - breathMs - CALL_DISPATCH_LAG_MS),
           firstNodeMs, breathMs }
}

leadInDispatchAtMs({ rep0CallDispatchAtMs, scheduledStartMs, clipDurationMs, vocabulary }) {
  const endByMs = rep0CallDispatchAtMs ?? scheduledStartMs
  const leadMs  = vocabulary === 'techniques' ? TECHNIQUE_LEADIN_LEAD_MS : 0
  return { dispatchAtMs: Math.max(0, endByMs - clipDurationMs - LEAD_IN_PAD_MS - leadMs), endByMs }
}
```
**`endByMs` is the rep-0 CALL's dispatch time, not the first strike.** Those differ by the call's whole lead (~2 s). Anchoring to the strike was *"precisely the drift this module exists to end"* — `tools/analysis/first-round-manifest.ts` did exactly that, and 12 workouts carried a permanent WARN for a defect in the *expectation*, not the app (`:5-24`, `:303-312`).

### 3.4 ⚠ `startPadMs` sidecar is COMPLETELY DEAD

Verified by exhaustive grep:
- `grep -rn "startPadMs" src/` → **zero hits**. The type that carried it (`PhraseAsset.startPadMs` in `src/audio/voiceAssets/phraseManifest.ts`) was **deleted** in V2 Phase 5-iv.
- `tools/voice/clip-shifts.json` still exists (778 bytes, mtime 2026-08-28) and is **`{"shifts": {}}` — empty by design**, with a `_comment` saying *"Empty by design; do not populate without a measurement."*
- Only three live references: `.claude/skills/cadence-lab/SKILL.md:95`, `tools/voice/cadence_audit.py:134` (a regex), and `tools/voice/make-phrase-clips.mjs:1073,1098` (which carries a DEPRECATED banner).
- `docs/audio-corpus.md:40` claims `_useWorkoutRunner.ts` "also reads `startPadMs`". **It does not.** That doc line is stale.

The runtime hook it would have fed is `RhythmMap`'s `phraseShiftFor`, which the runner stubs to `() => undefined` (§4.4).

### 3.5 RhythmMap coach-timing constants (`src/domain/programs/RhythmMap.ts`)

`RAIL_K_MS = 120` at **`:268`** (mirrored at `src/domain/programs/RhythmSpine.ts:44`; `timing-constants.mjs` warns if they drift apart). Note `docs/audio-corpus.md` cites it as `RhythmMap.ts:255` — wrong line.

Other constants in `:34-268` (verify individually before relying on an exact line): `DEFAULT_ANNOUNCE_LEAD_TIMES { announceMs: 750, readyToneMs: 100 }` `:35`; `BURST_REFIRE_INTERVAL_MS 6_000` `:51`; `MIN_BURST_MS_FOR_REFIRE 10_000` `:52`; `BURST_TAIL_QUIET_MS 1_500` `:53`; `INSTRUCTION_START_PAD_MS 250` `:120`; `SET_CALLOUT_QUIET_MS 500`; `SET_CALLOUT_PART_GAP_MS 450` (widened from 250 after parts stacked under tick jitter); `SET_CALLOUT_MIN_CLEAR_MS 200`; `ROUND_OPEN_QUIET_MS 1_500`; `CLOSER_AT_REMAINING_MS 30_000`; `CLOSER_SEARCH_BACK_MS 4_000`; 13-entry `CLOSER_ROTATION`; `REANNOUNCE_MIN_CLEAR_MS 150`; `PER_TOKEN_PHRASE_ESTIMATE_MS 500`; `ENCOURAGEMENT_GAP_MS 15_000`; `MAX_ENCOURAGEMENTS_PER_ROUND 6`; `POWER_MAX_TOKENS 2`; `POWER_MIN_INTERVAL_MS 5_000`; `POWER_MIN_REPS 3`; `POWER_STRIKES_MS 1_800`; `MAX_POWER_ANNOUNCES_PER_ROUND 2`.

`CueAnnouncer.ts`: `COMBO_TIGHTNESS = 0.72`, `SINGLE_TIGHTNESS = 1`, `MIN_TIGHTNESS = 0.45`, `FINAL_WARNING_AT_MS = 10_000`. `onRoundClock` fires once per round on the **first** sample at or below the threshold (`:752-760`) — "first crossing" rather than "equals" because the tick is 50 ms.

### 3.6 Audio-lane pads (`src/audio/VoiceOutputExpo.ts`)

| Constant | Value | line |
|---|---|---|
| `DEFAULT_CALIBRATED_AUDIO_OUTPUT_LATENCY_MS` | `40` | `:109` |
| `MIN_CLIP_GAP_MS` | `130` | `:265` |
| `FALLBACK_CLIP_MS` | `320` | `:273` |
| `COACH_LANE_RELEASE_GRACE_MS` | `50` | `:159` |
| `CLICK_SCRIPT_RESIDENT_CAP` | `8` | `:307` |
| `MAX_RESIDENT_PLAYERS` | `24` | `:293` |
| `ONE_SHOT_RELEASE_PAD_MS` | `1500` | `:316` |
| `CLICK_SCRIPT_PREARM_PAD_MS` | `200` | `:118` |

**Three different latency knobs for three different lanes** and they are not interchangeable: `DEFAULT_CALIBRATED_AUDIO_OUTPUT_LATENCY_MS` (40, score path via `dispatchAtMsForTickTime`), `CALL_DISPATCH_LAG_MS` (71, click-script path), `SlotDispatcher.latencyTicks` (score tick path).

### 3.7 Countdown / intro (`src/audio/introPlan.ts`)

```ts
INTRO_SEGMENT_GAP_MS      = 350    // :41  breath between plain sentences
INTRO_TAIL_PAD_MS         = 900    // :43  quiet after "Let's get started!" before the bell
INTRO_COUNTDOWN_SLACK_MS  = 1_500  // :54
totalMs = sum(gapBeforeMs + durationMs) + INTRO_TAIL_PAD_MS   // :114-117
```
The countdown is a **CAP, not a fixed lead-in**: `live.tsx` passes `countdownMs = intro.totalMs + INTRO_COUNTDOWN_SLACK_MS` when voice is on, and `skipCountdown()` rings the first bell as soon as the walkout lands rather than serving the slack in silence. The 1500 ms slack is deliberately tight — *"the old 15 s slack was sized for JS playback stalls that native playback made impossible"* (run 7's lesson).

On a click set, the **round-1 section-1 lead-in plays INSIDE the walkout** (`introPlan.ts:88-99`: `findClickScript('lead-in/<id>/r1s1')` is appended to the intro segments), and the runner's in-round scheduler skips s1 to match.

### 3.8 Rest sub-phases (`src/domain/session/restPhases.ts`)

```ts
REST_PHASE_ORDER = ['result', 'recovery', 'preview']   // :40
REST_RECOVERY_FRACTION = 0.2                           // :43
REST_PREVIEW_FRACTION  = 0.75                          // :45
```

### 3.9 Forensics (`src/diagnostics/vizForensics.ts`)

```ts
CLOCK_ANOMALY_MS   = 250   // :87  clock records written ONLY past this
FLUSH_BATCH        = 64    // :90
MAX_BUFFERED       = 512   // :98
FLUSH_INTERVAL_MS  = 500   // :113
```
Guard at `:199`: `if (wallDeltaMs < CLOCK_ANOMALY_MS && workDeltaMs >= 0) return`. M39-V2 principle #18: instrumentation must not perturb what it measures. **Do not add per-transition `logger.info` calls to the token/ring path** — a measured `baseBpm`/loop mismatch produced ~500 transport-hold logs/sec and red-screened the JS thread.

---

## 4. Voice call ↔ ring/click ↔ avatar frame ↔ expected strike

### 4.1 The four things and their anchors

Everything hangs off **one** authored moment per strike: `cue.scheduledStartMs + cue.tokenOffsetsMs[tokenIndex]`.

| Thing | Anchored at | Path | Owner |
|---|---|---|---|
| **Ring / node light** | exactly that moment | `beatOrdinalAtMsWorklet` inside `useFrameCallback` | UI thread |
| **Expected strike (acceptance)** | window `[that − 200, that + 350]`, truncated | `CueTimeline` graces + `truncateWindowsAtNextCue` | domain, at load |
| **Expected strike (scoring)** | `|punchTime − that| ≤ TIMING_TIGHT_MS` | `cueScoring.ts:43` / runner `onTimeForMatch` `:239-251` | domain |
| **Avatar frame** | that moment, read at `workElapsedMs + 375` | `avatarTrack.ts` | JS tick |
| **Voice call** | ends `breathMs` before the **first punch of the bar**, minus 71 ms | `callPlacement.callDispatchAtMs` | JS tick |
| **Audible click** | the loop WAV's own grid, swapped per section | `audibleDivisionForSlot` + `metronomeLoopFor` | native playlist |
| **Bell** | the phase transition itself; **not on any grid** | `CueAnnouncer.onSessionPhase` → `playAsset('bell')` | event |

### 4.2 Ring walk v3 — whole round staged, worklet walks by clock

`src/components/workout/useRingBeatClock.ts`. Two earlier designs died (header `:6-13`):
1. *adopt-what-JS-calls-current* — bars promoted **60-600 ms late**.
2. *stage-one-successor-ahead* — the engine flipped `current` faster than boundary promotes consumed it; captured stages #35..#39 in 5 s then promoted #38, bars **#34-37 never walked**; on-glass "stalled on the last node… hugs the far right".

Now JS stages the **entire** round once:
```ts
useEffect(() => { … }, [roundIndex, barCount, clock])   // :100 — keyed on the ROUND, nothing else
```
and the worklet walks it by clock (`:102-134`):
```ts
let idx = barIdx.value
while (idx + 1 < n && elapsed >= s[idx + 1]!) { idx += 1; …; runOnJS(onPromote)(…); runOnJS(onOrdinal)(epoch, -1) }
if (idx < 0) return
const target = beatOrdinalAtMsWorklet(s[idx]!, offsets.value[idx]!, expected.value[idx]!, elapsed)
if (target <= lastOrdinal.value) return
```
A cold/late join **SNAPS** (option-C: never replay what is over). Guard `:106`: `if (!c.running || c.roundIndex !== planRound.value) return`.

`src/domain/programs/beatProjection.ts:50-67` — `beatOrdinalAtMs(scheduledStartMs, tokenOffsetsMs, expectedTokenIndexes, workElapsedMs)` → punch ordinal or `-1`. Pure **projection, never an accumulator** (`:6-21`): *"A projection cannot have that class of bug… Replaying history is not possible because no history is read."* This is the structural fix for the 2026-08-31 catch-up-burst strobe. `src/components/workout/ringBeatMath.ts` holds the hand-mirror `beatOrdinalAtMsWorklet`, pinned by `src/components/workout/__tests__/ringBeatWorklet.test.ts`.

### 4.3 ⚠ Rings and the matcher use different index spaces

- `token-due` carries a **TOKEN index** over all tokens — defense / footwork / coach included; only `kind === 'rest'` returns early (`CueEngine.ts:461-494`).
- `beatOrdinalAtMs` returns a **PUNCH ORDINAL** over `expectedPunches`.

They are **not index-comparable**. Anything consuming `token-due` as "a punch happened" must filter by token kind itself.

`fireDueTokens` (`CueEngine.ts:461-494`):
```ts
const until = Math.min(t, cue.windowEndMs)   // tick-size invariance
cue.tokenOffsetsMs.forEach((offset, tokenIndex) => {
  if (cue.tokens[tokenIndex]?.kind === 'rest') return   // :476
  const strikeId = strikeIdFor(cue.id, DEFAULT_REP_ID, tokenIndex)
  if (runtime.firedTokens.has(strikeId)) return
  if (until < cue.scheduledStartMs + offset) return
  …publish 'token-due' with { tokenIndex, repId, strikeId, workElapsedMs: t, nowMs: clock.now() }
})
```
Dedupe is by **strikeId**, not tokenIndex: `firedTokens: Set<string>` of `` `${cueId}:rep-0:${i}` ``, migrated from `Set<number>` so the two `1`s in `1-1-2` are distinguishable (`CueEngine.ts:94-101`). `DEFAULT_REP_ID = 'rep-0'` (`src/domain/strikes/strikeCatalog.ts`).

The `until` cap and the rest-skip both exist for measurement integrity: without the cap the event stream would depend on frame rate; without the rest-skip every padded bar would inject phantom ring events into `puncheokie.cue.tokenDue` (the cadence-lab drift signal) and viz forensics (GH #305).

### 4.4 ⚠ "Call-vs-ring drift" — the current resolution is: **THE RAIL IS NOT ENGAGED**

The rail contract is *"Ring N lights `RAIL_K_MS` (120 ms) after word N's audible envelope ends."* It is **inert at runtime**. `.claude/skills/cadence-lab/SKILL.md:21-47` is the authoritative statement, headed **"Runtime status — READ FIRST (2026-09-07)"**:

> **The rail is not engaged at runtime.** Do not diagnose a drift report as a rail failure until this changes.

Verified in code today:
- `_useWorkoutRunner.ts:477-478` — `phraseShiftFor: () => undefined, wordMarksFor: () => undefined` (and again at `:1719`).
- `src/audio/VoiceOutputExpo.ts:1547` — `combinationDurationMs()` returns `undefined` unconditionally (Phase 5-iv retired the per-punch phrase corpus).
- `CueEngine.fireDueTokens` reads `cue.tokenOffsetsMs` **only**; `CueInstance` carries no per-token override (`phraseTokenTimesMs` retired in V2 Phase 5-ii).

So `RhythmMap.compileRoundRhythmMap` **always** takes the per-word branch (`:380-386`), and the entire `lengthMs !== undefined` block at `:387-414` — rail placement, `finishBy`, `phraseShift`, phrase-mode call events — is unreachable.

**Rings are on the beat grid, everywhere, today.**

What still exists, starved rather than missing:
```ts
// RhythmMap.ts:404-414
const finishBy   = cue.scheduledStartMs - leadTimes.readyToneMs
const phraseShift = opts.phraseShiftFor?.(combination, cadence) ?? 0
const railStartAt = railMarks && railWord0End !== undefined
  ? cue.scheduledStartMs - RAIL_K_MS - railWord0End : null
const railStartFits = railStartAt !== null && railStartAt >= cue.previewAt
const startAt = railStartFits ? railStartAt : Math.max(cue.previewAt, finishBy - lengthMs - phraseShift)
```
`RhythmSpine.ts:380-385` inverts it: `audioEndMs = atMs - RAIL_K_MS`, `audioAtMs = audioEndMs - (word.endMs - word.onsetMs)`. Per-token word onsets/ends survive for **562 of 776 clips** in `src/domain/programs/phraseTimingManifest.ts`.

Wiring it is **plan C6**. Until then, the measurable stand-in is *"announce end → first ring"*, and `observed-timing.mjs` reports `RAIL_K_MS` as `inert` in its proposals table (§7.3).

### 4.5 What actually places the voice on the 22 shipped workouts

`_useWorkoutRunner.ts:678-800` `buildLeadInSchedule(roundIndex)`, run once per round at `work-entered`:

1. Per sequence cue: `motif = tokens.map(punch ? `${n}${body?'b':''}` : '.').join('-')`; `slot = `call/${motif}``; `clip = findClickScript(slot, clickVocabularyRef.current)`.
2. `callDispatchAtMs(...)` places the clip to **END `breathMs` before the bar's FIRST PUNCH** (not bar start), minus `CALL_DISPATCH_LAG_MS`. `giveUpAtMs = firstNodeMs + 500`.
3. **Every** section's rep-0 gets its call, including the round opener (Variant B) — the first set used to be MUTED (whisper described it, rep 0 threw silent, coach entered on rep 1). Each round's first row now carries an authored `setupMeasures` pad (`tools/voice/fit-click-pads.mjs`).
4. Section 1 gets **no** mid-round lead-in (pre-bell ceremony owns it). Sections 2+ get `` `lead-in/${workout.id}/r${roundIndex+1}s${seenBlocks.size}` `` — section index is the block's **ORDER in the round**, not its id.
5. Collision filter at BUILD time (`:788-800`): a call whose window overlaps a lead-in's padded window (`liStart = li.dispatchAtMs - 500`) is dropped — **except** `firstRep` calls.
6. Entries sorted by `dispatchAtMs`.

Dispatch loop at `:2047-2130`:
- `if (entry.state !== 'pending' || snapshot.workElapsedMs < entry.dispatchAtMs) continue`
- past `giveUpAtMs` → `state = 'skipped'`; a skipped **lead-in** warns (`puncheokie.clickScript.skipped`), a skipped call is routine.
- gate is **`voiceAllowed(voice.policy, playbackActiveRef.current)` only** — `shouldSpeak` is never called. That is the only reason per-bar calls are audible at all under `voiceMode: 'minimal'`.
- busy check `voice.output.audibleUntilMs?.() ?? 0`: everything retries until `giveUpAtMs` **except** `firstRep`, which dispatches on schedule because it owns its authored `setupMeasures` pad by construction. Calls originally yielded on first contact and the skips **CASCADED** — measured 21/90 bars lost on-glass 2026-09-01.
- `traceId = `${entry.slot}#${entry.dispatchAtMs}`` (a slot can dispatch more than once per round via retries).
- `oneShot: entry.kind !== 'call'` — lead-ins release their native player after the clip; calls stay in the LRU.
- Logs `puncheokie.clickScript.dispatch` with `dispatchAtMs`, `lateMs`, `durationMs`, `endByMs`, `firstNodeMs`, `breathMs`, `lagMs`, `monotonicTimeMs`. **The analyzer scores delivered breath against `breathMs`, never against the dispatch time.**

Vocabulary is **snapshotted per round** (`clickVocabularyRef`, `:670`) — a mid-round flip applies from the following round.

### 4.6 Avatar frame

`src/domain/programs/avatarTrack.ts`:
```ts
buildAvatarTrack(cues)  // :33-48  — sequence cues only, punch tokens only
  dueMs = cue.scheduledStartMs + (cue.tokenOffsetsMs[tokenIndex] ?? 0)   // :42  — same moment the rings use
  entries.sort((a,b) => a.dueMs - b.dueMs)

avatarTargetIndex(entries, workElapsedMs, leadMs, fromIndex)  // :57-69
  const shifted = workElapsedMs + leadMs
  while (index + 1 < entries.length && entries[index+1].dueMs <= shifted) index += 1
```
A pure **TIME-SHIFT, never an acceleration** (`:6-17`). `fromIndex` is a monotonic cursor → O(1) per tick. Ordering doctrine holds by construction: the lead is constant, the cursor monotonic, sampling can only run *behind* the shifted clock under load, so the avatar cannot lap a rep.

Two clocks touch the avatar: `avatarTrack` picks **which** punch to demonstrate (session clock + 375 ms), while the **flip clock** (strike→retract→guard) rides `SharedTransportAnchor`, i.e. the metronome transport. That split is why a transport that never starts freezes the avatar (§6.4).

### 4.7 "bell ≠ voice" — the resolution

The bell is **not scheduled on any grid**. It is a voice **ASSET** fired from the phase transition, in `src/domain/coach/CueAnnouncer.ts:696-744`:

```ts
case 'work-entered':  … if (voiceAllowed(policy, playbackActive) && speakable('bell')) output.playAsset('bell')
case 'rest-entered':  // "Rounds end on the same ding-ding that starts them — the gong is retired
                      //  (Kyle: 'the ding ding sounds perfect, we want it for the end of the round')."
                      … output.playAsset('bell')
case 'finishing':     // "The last round ends on the ding-ding like every other."
                      … output.playAsset('bell')
```

`AUDIO_PRIORITY` (`src/domain/coach/VoiceOutputPort.ts:32-39`): `safety 0, bell 1, punchCommand 2, defenseFootwork 3, metric 4, coachingReminder 5`. Lower cuts higher. *"A bell outranks a punch command because missing the end of a round is worse than missing one combination."* `cancel(belowPriority)` drops only **QUEUED** items; a sounding clip is never chopped mid-syllable.

At `rest-entered` the runner calls `voice.output.cancel(AUDIO_PRIORITY.bell)` (`_useWorkoutRunner.ts:1588`) — this **drains** the ending round's un-fired queue while keeping the bell itself. Without that drain, `playSequence`'s append-not-clear semantics kept round-1 clips playing through rest into round 2.

The bell wav is **24 kHz** (`src/audio/voiceAssets/manifest.ts:107` → `assets/voice/numbers/standalone/bell.wav`) while the whole cornerman3 click bank is 48 kHz. Measured bell skew is 101.4 ms vs the call's 95.4 — within their own spread, so one constant covers both.

Ceremony budget: `WARN_END_TO_BELL_TARGET_MS = [0, 400]` (`tools/analysis/observed-timing.mjs:49`). Negative means the bell cut the countdown.

### 4.8 Round transitions, step by step

`WorkoutSessionClock.advancePhase` (`:228-261`): `work` → `rest` (`phaseElapsedMs = overflow`) unless last round with `rest <= 0` (→ `complete`) or `rest <= 0` (→ `enterWork(next, overflow)`); `rest` → `enterWork(next, overflow)` or `complete`.

`_useWorkoutRunner.applyTransitions` (`:1499-1640`), per transition: map to `SessionPhaseEvent` (**mapped, not cast** — `completed` becomes `finishing`; a cast "would compile and then silently deliver a phase the announcer does not recognise"), call `announcer.onSessionPhase`, publish `SharedWorkClock`, log `puncheokie.round.boundary`.
- **`work-entered`** `:1546-1573`: `freeze.beginRound` → `buildWalkPlan` → `buildLeadInSchedule` → `buildAvatarLeadTrack` → `buildMetronomeSchedule` → `announcer.setRound(round, map)` → `engine.onSessionPhase` → `startMetronome()`.
- **`rest-entered`** `:1574-1616`: freeze round result → `engine.onSessionPhase` → `stopMetronome()` → `voice.output.cancel(AUDIO_PRIORITY.bell)` → `pacing.onBoundary('rest', …)`.
- **`paused` / `resumed`** `:1617-1625`: `stopMetronome()` / `startMetronome()`. The runner treats pause as a **hard metronome stop** and resume as a **fresh start** — *"a paused loop that resumes from its previous position would land off the downbeat by the pause duration"* — which **does** bump transport `generation`, even though `MetronomeTransport.pause/resume` themselves preserve it.

⚠ **Known harmless bug**: the `SharedWorkClock` publish is inside the per-transition loop but reads `sessionRef.current.snapshot()` each time — and `session.advance()` has already applied **all** transitions before `applyTransitions` runs. When one advance crosses two boundaries (rest-entered + work-entered), **both iterations publish the same final snapshot**. Harmless today only because the final state is the one that matters.

### 4.9 Pause / resume semantics, layer by layer

| Layer | On pause | On resume |
|---|---|---|
| Session | `pause()` flips phase only (`:146-152`) | `resume()` sets `lastAdvanceAtMs = now` → paused interval discarded (`:154-159`) |
| CueEngine | `paused \|\| trackerFault` → `isSuspended()`; `tick()` returns early; `SUSPENDABLE = {announcing, active, accepting}` → `'suspended'` with `priorStatus` saved + a monotonic suspension span pushed (`:511-533`) | re-emits the current cue's lifecycle |
| Transport | `pause()` freezes `anchorAbsoluteTick`, generation unchanged (`:185-193`) | `resume()` re-anchors monotonic, generation unchanged (`:198-207`) — **but the runner stops/starts instead** |
| Announcer | `cancel(AUDIO_PRIORITY.safety)` — everything below safety goes (`:698-705`) | nothing to replay |

⚠ `CueEngine.tick` ignores a backwards tick and returns early while suspended **without updating `lastTickMs`** — so `snapshot().remainingMs` and `repeatCue()` read a frozen `lastTickMs` during a pause. Intended. But `loadRound` resets `lastTickMs` to `-1`, so the first tick of a round can be any value.

---

## 5. Acceptance windows, clamping, anchors

### 5.1 The REAL acceptance window

`src/domain/programs/CueTimeline.ts`
```ts
DEFAULT_GRACE_BEFORE_MS = 200   // :55
DEFAULT_GRACE_AFTER_MS  = 350   // :56
```
Rationale verbatim (`:47-54`): *"Asymmetric on purpose: a punch landing slightly late is ordinary — the athlete heard the cue and moved — whereas one landing well before it was called was not a response to the cue at all."*

Sequence cues, `expandBlock` `:412-425`:
```ts
windowStartMs: Math.min(ctx.workDurationMs, Math.max(0, scheduledStartMs - ctx.graceBeforeMs))
windowEndMs:   Math.min(ctx.workDurationMs, scheduledEndMs + ctx.graceAfterMs)
```
The **upper clamp on the start is not redundant** (`:397-411`): `repeat` lays instances at a beat-derived stride that expansion never checks against the round length, so a repeated combo can be scheduled wholly past the bell. Without it: `windowStartMs > windowEndMs`, an inverted window no downstream assertion looks for.

Then `truncateWindowsAtNextCue(cues)` at `:334-341` (called from `:297`):
```ts
cue.windowEndMs = Math.max(cue.windowStartMs, Math.min(cue.windowEndMs, next.scheduledStartMs))
```
Floored at the cue's own `windowStartMs` so a window is never inverted. The truncated end **can precede `scheduledEndMs`** when the overlap is severe — the engine then closes the cue out of `active` rather than waiting for `accepting`. Reasons (`:320-326`): a punch inside the overlap would be creditable to two cues (spec §28.2 needs exactly one), and the engine's "one cue in flight" model (doc §20) would be violated.

Per-block overrides: `block.graceBeforeMs` / `block.graceAfterMs`; global via `ExpandOptions.graceBeforeMs/graceAfterMs` (`:63-66`, defaults resolved at `:242-243`).

### 5.2 The 200 ms overlap is structural

Because `windowStart` opens 200 ms before `scheduledStartMs` while the *previous* cue's window is truncated **AT** that same `scheduledStartMs`, `cue-window-opened(N)` **always** arrives before `cue-window-closed(P)`. `src/domain/programs/LiveCueMatcher.ts:142-192` `onCueEvent` is **cue-id-keyed for exactly this reason**; an unkeyed single slot orphaned the matcher after a round's first cue (2026-08-31).

### 5.3 Windows are asserted, not re-derived

`CueEngine.ts:640-652`, called from the constructor at `:126`:
```ts
function assertWindowsClamped(timeline) {
  for (const round of timeline) for (const cue of round.cues) {
    if (cue.windowStartMs < 0 || cue.windowEndMs > round.workDurationMs) throw new Error(…)
  }
}
```
Header `:634-639`: *"The engine asserts rather than re-clamps: a window outside the work interval means expansion is broken, and quietly correcting it here would hide that while letting events be accepted during rest."*

⚠ **GAP**: the assertion tests only `windowStartMs < 0 || windowEndMs > workDurationMs`. It does **not** test `windowStartMs > windowEndMs`.

⚠ **ACTIVE BUG** — count-scored blocks can produce an inverted window. Compare:
```
CueTimeline.ts:412-414  (expandBlock)            windowStartMs: Math.min(workDurationMs, Math.max(0, start - graceBefore))
CueTimeline.ts:485      (expandCountScoredBlock) windowStartMs: Math.max(0, scheduledStartMs - ctx.graceBeforeMs)
CueTimeline.ts:486                               windowEndMs:   Math.min(ctx.workDurationMs, scheduledEndMs + ctx.graceAfterMs)
```
`expandCountScoredBlock` is missing the `Math.min(workDurationMs, …)` on the start. A count-scored block scheduled past the bell gets `windowStartMs > windowEndMs`, and `assertWindowsClamped` will not catch it. Low practical impact today (the 22 shipped click maps emit only `'repeated-combo'`), but it is a real asymmetry.

### 5.4 Cue lifecycle + tick-size invariance

`CueEngine.ts:307-325`: `advance()` runs `step()` in a `for(;;)` until the status stops changing, so **one large tick can carry a cue through several states** — a dropped frame must not strand it. Combined with `fireDueTokens`' `until = Math.min(t, cue.windowEndMs)` cap, a coarse tick fires exactly the tokens a fine one would.

**Tick-size invariance is pinned by ~60 seeded-timeline tests and must not be "fixed".**

Statuses: `queued → previewing → announcing → active → accepting → (completed | expired) → gap`. `TERMINAL_STATUSES = {completed, expired, gap, cancelled}` (`CueState.ts`). `closeOverlapping()` ends any in-flight cue when a new one goes active; `assertSingleActive()` throws if two are active.

### 5.5 Scoring windows ≠ acceptance windows

`src/domain/programs/cueScoring.ts:43`
```ts
export const TIMING_TIGHT_MS = 150
```
Comment `:36-42`: *"Distinct from the acceptance window, which is far wider: the window decides whether a punch belongs to the cue at all, while this decides whether it was on the beat. A placeholder until M36-03 tunes it against real punching."*

Runner's haptic gate (`_useWorkoutRunner.ts:245-251`):
```ts
const dueMs = cue.scheduledStartMs + (cue.tokenOffsetsMs[expected.tokenIndex] ?? 0)
return Math.abs(eventTimeMs - dueMs) <= TIMING_TIGHT_MS
```

⚠ `docs/design-spec.md` D20 says *"Timing is no longer scored"* and `timingWindowPct` is retired, but `cueScoring.ts` still computes and aggregates `timingWindowPct` (lines 56, 164, 226, 246, 254). **The doc and the code disagree.**

### 5.6 ⚠ `src/domain/timing/acceptance.ts` is DEAD at runtime

```ts
EXPECTED_STRIKE_DELAY_MS = 140   // :25
ACCEPT_FROM_MS           = 60    // :28
ACCEPT_UNTIL_BASE_MS     = 400   // :31
acceptUntilMsFor(division): 1|2 → 400, 3 → 450, 4 → 500   // :40-49
```
The stated model (`:5-10`): voice onset = grid time; circle activation = grid time; expected physical punch = grid + 140 ms; acceptance = grid + 60..400.

**Consumed only by `TimingEngine.scheduleCombination`, which has no caller outside `src/domain/timing/__tests__`.** Two unrelated acceptance models coexist. **Changing `acceptance.ts` changes nothing on glass.** The windows that actually gate matching are `DEFAULT_GRACE_BEFORE_MS = 200` / `DEFAULT_GRACE_AFTER_MS = 350` plus `truncateWindowsAtNextCue`.

Same for the whole swing / `RhythmicCombination` half of `TimingEngine`: `stepOffsetMs`, `SWING_EVEN/ROLLING/SINGSONG/MAX`, `density`, `plannedPacePerMinute`, `callSlotsPerMinute`, `combinationDurationMs(combo)`, `scheduleCombination`, `ScheduledPunch` — no non-test importer. Swing survives only as a WAV-selection key in `metronomeAssets`, and every shipped sample authors `swing: 0.5`.

### 5.7 Anchors and the backwards-snap clamp

`src/audio/MetronomeTransport.ts`
```ts
PHASE_CORRECTION_LARGE_TICKS    = 500   // :86  ~520 ms at 60 BPM
PHASE_CORRECTION_MAX_STEP_TICKS = 20    // :87  ~20 ms slew cap per observation
```

`correct(obs)` at `:248-312`. Guards first: not running → return; `obs.observedGeneration !== this.generation` → return (a stale generation means the transport restarted between observation and delivery); `ticksPerSecond <= 0` → return; `observationAgeMs < 0` → return ("observation from the future").

```ts
const predictedTickNow = this.absoluteTickAt(now)
const observedTickNow  = obs.observedAbsoluteTick + (observationAgeMs / 1_000) * this.ticksPerSecond
const errorTicks = observedTickNow - predictedTickNow
```

| `|error|` | sign | action |
|---|---|---|
| ≥ 500 | **negative** | **HOLD, always.** No anchor change, no generation bump, no notify. Summarised log at most **1/s**. |
| ≥ 500 | positive | hard re-anchor (`anchorMonotonicMs = now`, `anchorAbsoluteTick = observedTickNow`) + `generation += 1` + `notify()` |
| < 500 | positive | slew `anchorAbsoluteTick += Math.min(errorTicks, 20)`, no notify |
| < 500 | **negative** | **HOLD.** "visual monotonicity wins." |

**This is "the backwards-snap clamp."** Comment `:261-275` is the whole story:

> *NEVER snap the visual clock backwards — the contract stated at the top of this file, which this branch used to violate while the small-error branch honoured it (GH #305). A large NEGATIVE error means JS ran ahead of audio (typically a JS stall being caught up); seeding the anchor at `observedTickNow` rewound the clock **~250-380 ms**, and the avatar worklet wraps elapsed time modulo the beat, so every rewind re-entered the flip cycle at an arbitrary phase — **a spurious re-strike**. **~Half of all storm events carry negative error**, so this halves the storm's visual impact by construction.*

**The anchor storm, resolved:** before the clamp, **~300-400 re-anchors per round**, ~99 % negative-error. After, **4-12 per round**. In the most recent 22-drive suite every row reports `reanchor=0` (§7.2) — the storm is now fully quiet on glass.

The 1 Hz log summarisation exists because *"a baseBpm/loop mismatch produced ~500 holds/sec, and logging each one floods the JS thread into a red screen"* (`:276-281`). Fields: `generation`, `held`, `worstErrorTicks`.

`notifyDisruption()` (`:313+`) preserves the tick but bumps generation — for Bluetooth route changes, iOS interruptions, Android background pauses, native player restarts.

`src/audio/wrappedPositionToAbsoluteTick.ts` reconstructs the absolute tick from a wrapped expo-audio playlist position using JS monotonic time as a coarse anchor. **Correct only while JS↔audio skew < half a loop** (500 ms on a 1 s loop).

`src/audio/useSharedTransportAnchor.ts` — `bindSharedTransportAnchor` publishes **whole-struct atomic** updates on every transport transition, plus one initial publish on bind. Field-wise updates would let the worklet observe a torn state. Frame-timestamp domain = `performance.now()`.

### 5.8 SlotDispatcher round band (precall bleed)

`src/audio/SlotDispatcher.ts:157-233`. `dispatchAtTick = reservationStartTick - latencyTicks`.

The score axis has **no rest gap**, so consecutive round starts sit exactly `workDurationTicks` apart. A round's opening announce is authored to **LEAD** its bell (`speed-combos` round 1: **−2355 ms**, absolute tick **228139** in a round-0 band ending at **230400**). Measured on-glass: round 1's *"One, Two, go!"* fired **2.7 s before the round-0 bell**, while the athlete was still working round 0.

Current behaviour (`advance(nowTick, currentRoundIndex = null)`):
- `head.roundIndex > currentRoundIndex` → `held.push(head)` and **continue** (not return early — a future-round slot can sort ahead of a still-due current-round slot, so returning would starve the other).
- `head.roundIndex < currentRoundIndex` → dropped, `onSkipped(head, 'round-elapsed')`. *"the previous round's combination called over the current round is worse than silence."*
- `play()` returning `false` → `dispatched.delete(slotId)`; re-queued if `nowTick < head.desiredAudibleEndTick`, else `onSkipped(head, 'retry-expired')`.
- Held slots re-queued in a **`finally`** block (`:226-232`) *"so a throw from `play()` cannot strand held slots outside the queue, which would silence them for the whole workout."*

⚠ **`SlotDispatcher` is dormant in production.** `scoreDispatchEnabled = workout.recipe.voiceMode !== 'minimal'` (`_useWorkoutRunner.ts:1759`), and **all 22 shipped workouts set `voiceMode: 'minimal'`** (verified: 11 literal sample files + `composeFromChunks.ts:152` for the 12 quick ones). So on the workouts that ship, `SlotDispatcher` is never constructed, `compileWorkoutScore` never runs, and no combo-announce ever plays. Reading `SlotDispatcher.ts` to understand "how the coach speaks today" will mislead you.

---

## 6. The "one grid" fix (867 ms → ~1 ms)

### 6.1 What was wrong

Two independent defects, both GH #305:

**Blocker 1 — double-counted offset.** `compileWorkoutScore` added `ticksAtMs(cue.scheduledStartMs)` on top of a compiled tick that already contained it (`programCueBridge` puts the same offset in `executeAtTick`, and `compileCue` builds every strike from `executeAtTick + …`). Every event landed at roughly **twice** its authored offset. The last round-0 strike sat at **209 s of a 240 s round instead of 104 s**.

**Blocker 1b — tempo-blind placement.** `programCueBridge` emitted only `atStep: ordinal`, and `compileCue` placed strikes at `atStep * unitTicks`. `unitTicks` is a fixed fraction of the **60-BPM base pulse**, so step-placed strikes sat **500 ms apart at every workout tempo** — *"measured identical at 85 and 240 BPM across all ten samples"* — while the rings ran tempo-scaled `tokenOffsetsMs`. The two grids **diverged by up to 867 ms** (`src/domain/programs/compileCue.ts:94`).

**None of the 38 ordering/bounds tests noticed**, because a uniform doubling and a uniform lattice both preserve ordering.

### 6.2 The fix

`src/domain/programs/programCueBridge.ts:167-199`:
```ts
const offsetTicks = punchIndexes.map((tokenIndex) => ticksAtMs(cue.tokenOffsetsMs[tokenIndex] ?? 0))
const strikes = punchIndexes.map((tokenIndex, ordinal) => {
  const atTick  = offsetTicks[ordinal]!
  const nextTick = offsetTicks[ordinal + 1]
  const prevTick = offsetTicks[ordinal - 1]
  const endAtTick = nextTick !== undefined ? nextTick
    : prevTick !== undefined ? atTick + (atTick - prevTick) : undefined
  return { token: strikeTokenFor(token.number, token.body), atStep: ordinal, atTick, …(endAtTick !== undefined ? { endAtTick } : {}) }
})
```
`src/domain/programs/compileCue.ts:374`:
```ts
const startTick = repStartTick + (authored.atTick ?? authored.atStep * unitTicks)
```
`atStep` survives **only as the compiler's documented fallback** for hand-written patterns and tests.

Also: `combo.totalTicks = lastStrike.endAtTick` when present (`programCueBridge.ts:203-209`), so the (production-dormant) rep stride cannot lie either. `targetStrikeTick = startTick + Math.round((endTick - startTick) / 2)` (`compileCue.ts:401`). `DEFAULT_RESPONSE_GAP_TICKS = 60` (`compileCue.ts:321`), overridable via `cue.responseGapTicks`.

**Blocker 2** fix is `src/domain/programs/scoreClock.ts` (§6.3).

A **false comment** was part of why this survived: `programCueBridge`'s header used to claim `atStep` was derived from `beatOffset` — it never was. The corrected header (`:24-29`) says so explicitly.

### 6.3 `scoreClock.ts` — the cumulative/round-relative lift

```ts
const MS_PER_SCORE_TICK = 60_000 / (60 * TRANSPORT_TICKS_PER_PULSE)   // :29
roundStartTicksFrom(score)  // :37-43  reads score.phaseBoundaries where kind === 'round-start'
scoreTickAt(roundStartTicks, workElapsedMs, roundIndex) =
  (roundStartTicks[roundIndex] ?? 0) + Math.round(workElapsedMs / MS_PER_SCORE_TICK)   // :51-57
```
Round starts (4:00 rounds): **0, 230400, 460800** ticks. Rest is **NOT** represented in the axis. `?? 0` on an unknown round degrades to round-0-only rather than throwing mid-workout. `roundStartTicksFrom` reads the score's own boundaries *"rather than re-deriving from durations, so the two can never disagree."*

### 6.4 The invariant now, and how to not break it again

**Invariant:** every strike's position in the compiled score is `ticksAtMs(cue.scheduledStartMs + cue.tokenOffsetsMs[i])` — the *same* tempo-scaled authored offsets the rings and `beatOrdinalAtMs` run on. **One grid.**

Pinned by two tests in `src/domain/programs/__tests__/workoutScore.test.ts`:

1. **`:225-267`** — *"places each strike at its AUTHORED offset — the cue offset is counted exactly once"*. Asserts `Math.abs(first.startTick - msToTicks(cue.scheduledStartMs + cue.tokenOffsetsMs[firstPunchIndex])) <= 2` ticks (±2 ticks ≈ **±2.08 ms**, for the independent rounding on each side), over >10 cues, plus `lastStrike.startTick <= msToTicks(lastCue.windowEndMs)`. It also "guards the guard": `expect(checked).toBeGreaterThan(10)` so a lookup that silently matched nothing cannot make the loop vacuously true.
2. **`:269+`** — *"strike spacing is TEMPO-SCALED — the grid follows the workout BPM"*. Compiles the same workout at bpm 60 and 120 and asserts the per-cue gap **ratio**.

> ⚠ **Only a cross-TEMPO RATIO test catches this class.** 38 ordering/bounds tests passed while the compiled score sat on a fixed 500 ms lattice. When touching `compileCue` / `programCueBridge` placement, assert that strike spacing **SCALES** with bpm, not just that it is ordered.

**On the "867 ms → 1 ms" figure:** 867 ms is a real code comment at `compileCue.ts:94`. The "1 ms" / "≤0.98 ms" post-fix figure is **not present anywhere in the repo** — grep returns nothing. The *executable* post-fix guarantee is the **±2 ticks (±2.08 ms)** tolerance above. Quote that, not 0.98.

### 6.5 ⚠ `metronomeAssets` has no baseBpm 120 loop

`src/audio/voiceAssets/metronomeAssets.ts:29-44` — the complete list of 14 rendered loops:

| baseBpm | divisions | swings | bar durationMs |
|---|---|---|---|
| 60 | 1, 2, 3, 4 | 0.5 (+0.54 on d2, d4) | 1000 |
| 100 | 1, 2, 3 | 0.5 (+0.54 on d2) | 600 |
| 85 | 1, 2, 3 | 0.5 (+0.54 on d2) | 706 |

`metronomeLoopFor(division, swing, baseBpm = 60)` at `:51-56`: exact `(baseBpm, division, swing)` → straight-swing (0.50) for that `(baseBpm, division)` → `undefined`.

Nothing requests 120 today because the 120-BPM maps use `baseBpm 60, division 2`. But **any recipe that sets `baseBpm: 120` gets `undefined`**, a `puncheokie.metronome 'no loop for tempo'` warn (`_useWorkoutRunner.ts:1469-1474`), and `startMetronome` **returns without starting the transport**. Because the avatar flip clock rides `SharedTransportAnchor`, that also **freezes the avatar**. This is exactly the bug class that left the avatar frozen on 7 of 11 workouts.

### 6.6 ⚠ PacingEngine proposes but nothing applies

The runner calls `pacingRef.current.onBoundary('rest', …)` and pushes an `AdaptationRecord`, but **only `decision.cueText` is consumed** (`pacingCueRef` → store, `_useWorkoutRunner.ts:1606`). The timeline is `useMemo`'d on `[workout, stance, bpm]` and `expandTimeline` is never re-run mid-session, so a `'cadence-scale'` / `'gap-scale'` / `'reallocate'` action is **inert**. Much of `CueTimeline`'s clamping rationale (`:397-411`, *"PacingEngine's ±10-15% adjustment does exactly that"*) describes a path that cannot currently fire.

### 6.7 ⚠ `docs/v1c-ring-avatar-sync-plan.md` is a stale plan, not a description

The `visualOffsetsMs ?? phraseTokenTimesMs ?? tokenOffsetsMs` authority chain and the proposed `src/domain/programs/tokenOffsets.ts` **do not exist**. `CueInstance` carries neither field (retired in V2 Phase 5-ii). `CueEngine.fireDueTokens` reads `cue.tokenOffsetsMs` directly.

---

## 7. How to MEASURE all this

### 7.1 Pure-domain first (always)

Metro's watcher is **blind on the F: drive** — there is no fast refresh, ever. Every edit batch needs a Metro restart **plus** an app cold-restart to reach the tablet, and after a mass wav rewrite a stale Metro breaks clip loading outright. **Budget for this before concluding a code change "did nothing."**

So iterate here first:
```bash
cd F:/punchCraft && npx jest src/domain/timing src/domain/session src/domain/programs src/domain/workout/__tests__/cadence
```
**Verified green 2026-11-25: 35 suites, 832 tests passed, 13.2 s.** (The prior survey's "180 tests" was a narrower selection; this is the real figure for the full timing surface.)

Targeted suites worth knowing: `src/domain/programs/__tests__/workoutScore.test.ts` (the one-grid + tempo-ratio gates), `beatProjection.test.ts`, `src/components/workout/__tests__/ringBeatWorklet.test.ts` (worklet/JS parity), `CueEngine.lifecycle.test.ts` (tick-size invariance), `src/domain/workout/samples/__tests__/clickCallFit.test.ts` (stride law — `clip.durationMs <= strideMs − 100`, 8/8 green), `mapCallShifts.test.ts`, `RhythmSpine.test.ts`.

> ⚠ Jest runs everything on one thread, so it **cannot** see a missing `'worklet'` directive. That failure (`[Worklets] Tried to synchronously call a Remote Function on the UI Runtime`) is an instant red screen on device and invisible to the test suite.

### 7.2 The measurement loop (`.claude/skills/cadence-lab/SKILL.md:51-82`)

```bash
# 1. LIVE, MIC-FREE — the standing check. Drive a workout with the QA flag on
#    (see the qa-audio-verify skill), then:
node tools/analysis/observed-timing.mjs --session <sessionDir>
#    → observed-timing-report.{json,md} with `proposals`
#    Exit 0 clean / 1 hard (coverage, truncation, fit > 250 ms) / 2 soft

# 2. WHOLE SUITE — 22 workouts unattended, one summary
node tools/analysis/verify-suite.mjs --all --expect-release
#    → tools/analysis/suites/<epoch>/summary.md

# 3. CONSTANTS — regenerate whenever cadence.ts, the rhythm map, or a
#    breath/lead constant changes. Every analyzer reads this, never a literal.
node tools/voice/build-cadence-grid.mjs      # also writes timing-constants.json
node tools/analysis/timing-constants.mjs     # constants alone

# 4. RAIL VERIFICATION — once C6 lands marks
node --import ./tools/analysis/wav-stub.mjs --import tsx tools/analysis/phrase-timing-dump.mjs
F:/voice-tools/venv/Scripts/python.exe tools/audition/rail_verify.py <sessionDir>
#    Today it exits 3 with "the rail is INERT, not broken" — correct and expected

# 5. MIC — Tier-2 only, when the schedule is provably right and audio still reads drifty
node tools/audition/monitor-session.mjs --duration=25 --out=tools/analysis/monitor/cadence-<date>
F:/voice-tools/venv/Scripts/python.exe tools/audition/cadence_analyzer.py <sessionDir>
```

**`tools/analysis/timing-constants.mjs` — read this before renaming any constant.** It regexes values out of the TypeScript sources so no analyzer carries a literal. Sources it reads: `src/domain/coach/callPlacement.ts`, `src/app/(tabs)/punchcraft/_useWorkoutRunner.ts`, `src/audio/VoiceOutputExpo.ts`, `src/domain/programs/RhythmMap.ts`, `src/domain/programs/RhythmSpine.ts`, `src/audio/PlaybackObserver.ts`, `src/audio/timingCalibration.ts`. A constant it cannot find reports as **`null`**, not a default, *"so a rename shows up in the report instead of silently pinning an old value."* It also warns when `RAIL_K_MS` and its `RhythmSpine` copy drift apart. Helpers: `readNumberConst` (`:41`), `readRecordConst` with a `scope` so `DENSE_BREATH_MS`'s named sums resolve (`:55`), `evalSum` (`:67`), `readOverrides` (`:89`).

Verified output, run 2026-11-25:
```json
{ "rail":  { "RAIL_K_MS": 120, "RAIL_K_MS_spine": 120 },
  "breath":{ "DENSE_BREATH_MS": { "numbers": 600, "techniques": 750 },
             "MIN_BREATH_MS": 150, "DELIVERED_BREATH_SHORTFALL_MS": 95,
             "BREATH_REF_SLOT_MS": 300, "BREATH_TRACK_GAIN": 1,
             "CALL_BREATH_OVERRIDES": { "call/1-.-.-.": 340, "call/1-.-2-.": 340 } },
  "leads": { "LEAD_IN_PAD_MS": 250, "CALL_PAD_MS": 500, "CALL_DISPATCH_LAG_MS": 71,
             "TECHNIQUE_CALL_LEAD_MS": 250, "TECHNIQUE_LEADIN_LEAD_MS": 500,
             "NUMBERS_CALL_LEAD_MS": 100, "METRONOME_SWAP_LEAD_MS": 400, "AVATAR_LEAD_MS": 375 },
  "audio": { "DEFAULT_CALIBRATED_AUDIO_OUTPUT_LATENCY_MS": 40, "ONE_SHOT_RELEASE_PAD_MS": 1500,
             "CLICK_SCRIPT_PREARM_PAD_MS": 200, "OBSERVED_UPDATE_INTERVAL_MS": 40,
             "OBSERVED_PLAYLIST_UPDATE_INTERVAL_MS": 40 },
  "calibration": null }
```
Console: `calibration: none yet (plan C4 — one mic session produces src/audio/timingCalibration.ts)`. **`src/audio/timingCalibration.ts` does not exist**; `PLAYHEAD_TO_SPEAKER_MS` is still unmeasured, so every onset number in every report is a **playhead onset**, not a speaker onset.

⚠ Two mislabels in that output: `leads.source` and `breath.source` both report `callPlacement.ts`, but `METRONOME_SWAP_LEAD_MS` and `AVATAR_LEAD_MS` are actually read from the **runner** (`timing-constants.mjs:152-153`). Cosmetic, but don't trust the `source` field for those two.

### 7.3 Analyzer gates — the numeric definition of "good"

`tools/analysis/observed-timing.mjs`
| Constant | Value | line | Meaning |
|---|---|---|---|
| `COVERAGE_HARD` | `0.98` | `:46` | below → exit 1 |
| `FIT_DISAGREEMENT_HARD_MS` | `250` | `:47` | work-axis fit vs boundary; above → exit 1 |
| `FIT_DISAGREEMENT_SOFT_MS` | `50` | `:48` | above → soft warn |
| `WARN_END_TO_BELL_TARGET_MS` | `[0, 400]` | `:49` | negative = the bell cut the countdown |
| `RAIL_TIGHT_MS` | `60` | `:50` | announce-end → first-ring tightness |
| `BREATH_PROPOSAL_MIN_MS` | `40` | `:52` | a smaller per-slot shift is noise, not a proposal |
| `GLOBAL_SHIFT_BAND_MS` | `50` | `:62` | when every slot's late end sits inside this band, **ONE** constant explains them all and per-slot overrides are noise dressed as findings (measured: four slots of different lengths each ended 198–205 ms late over 46 bars) |
| `OBSERVER_ONSET_SKEW_MS` | `95` | `:100` | **ONE DOMAIN** — applied once at the boundary via `withCorrectedOnset`; `obs.onsetMs` IS the corrected onset everywhere below. Playlist skew measured **94.8 ms** over 48 reps / six shapes (plan 5b) vs the player's 95 — they share `BaseAudioPlayer` on Android. The old two-domain machinery (`SKEW_CORRECTED_KINDS`, two converters, three ternaries) was where the bugs lived: *"The same defect — a corrected millisecond subtracted from a raw one — was found and fixed by hand three times in one day."* Raw survives as `onsetMsRaw` / `onsetLatencyMsRaw`, read in exactly two places. |
| `SKEW_CROSS_CHECK_TOLERANCE_MS` | `45` | `:148` | end-event residual median beyond ±45 → the skew constant may be stale. Observed spread by path ≈ +29 / −1 / −28. |
| `SKEW_CROSS_CHECK_MIN_SAMPLES` | `10` | `:150` | below this one slow teardown moves the median |
| `LEAD_IN_TO_CALL_WINDOW_MS` | `6_000` | `:159` | past this the next sound is the following section |
| `FLOOR_BREACH_SOFT_RATIO` | `0.02` | `:171` | share of bars allowed under `MIN_BREATH_MS` before warning. **Deliberately not zero** — tighter workouts run 8-15 % under today and this gate exists to watch that shrink. A **ratio**, so a 47-bar drive and a 185-bar drive are held to the same standard. |
| `WORST_BARS_LISTED` | `5` | `:174` | |
| `TAIL_MIN_SAMPLES` | `20` | `:72` | below this, `percentile(v, 95)` returns the **maximum** (index `ceil(0.95n)-1` is the last element for every n ≤ 19). Calling that "p95" *"dresses a single worst sample as a distribution, and both quick-workout reports did exactly that from n = 11."* |
| `BELL_WINDOW_MS` | `[-500, 3000]` | `:63` | |
| `TRUNCATION_MS` | `150` | `observed-summary.mjs` | a play cut short by more than this is a hard finding |

**`barsAtOrPastPunch` is the correctness gate and has no tolerance at all** (`:170`). That is the "never-late" invariant: *delivered breath ≤ 0 means the call was still sounding when the punch was due.*

### 7.4 What good actually looks like — a real report

`tools/analysis/suites/1789142947855/body-work/observed-timing-report.md` (release, sha `76e0c534`, **2026-09-11T16:09Z**, the most recent suite on disk). This is the shape to pattern-match against.

```
verdict: exit 2 · soft: 15/227 bars (6.6%) delivered under the 150 ms breath floor — min 16.1 ms;
         9 lead-in(s) ended past endBy (median 23.9 ms);
         round 1: warn end → bell 432 ms (target 0–400); round 2: 478 ms
coverage: 99.3% (265/267)
```

**Onset latency by family** — `click-script`: 259 plays, 257 observed, median **119.5**, p95 231, jitter 111.5, by path `fresh 214.5/294 (n26)`, `armed 117/203 (n191)`, `rewound 110/222 (n23)`, truncated 0.

**Work axis fit** (the one-grid health check; this is the ring↔score agreement in practice):
```
round 0: offset 424212128.117 ms from 241 tokenDue (spread 1.6) · disagreement 65.1 ms
round 1: offset 424512128.096 ms from 221 tokenDue (spread 1.4) · disagreement 14.7 ms
round 2: offset 424812128.080 ms from 234 tokenDue (spread 1.3) · disagreement 16.3 ms
round 3: offset 425112128.084 ms from 213 tokenDue (spread 1.3) · disagreement 11.4 ms
```
**`spread` 1.3–1.6 ms over 200+ tokens per round is the one-grid invariant holding on glass.** Disagreement 11-16 ms is well inside the 250 ms hard gate; round 0's 65.1 ms is over the 50 ms soft gate (bell/first-token alignment).

> **2026-11-27 — round 0's 65.1 ms is not what good looks like.** It was a fault (findings doc §3i, N-18): a round opened by a skip, as round 1 always is, started its work clock at the tick before the skip, so the calls and the scoring ran that far ahead of the bell and the painted rings. Fixed in `3c1716c9` and `495a67a8`. On a build with the fix, round 0 should read like rounds 1 to 3 here; a round 0 well above them is the fault back. A native build in an emulator shows it fixed (round 0 at 11.9 ms beside 14.4); no tablet has run the fix yet.

**Breath table** (227 calls) — note `intended` matches `breathForBar` exactly (600/500/300 for `slotMs` 300/400/600):
```
| slot                     |  n | intended | delivered min | median | p95   | shortfall median |
| call/1-2b-1-2b           | 12 |   300    |      78.1     | 191.1  | 257.1 |      108.9       |
| call/1-1b-2-.            | 20 |   600    |     385.1     | 496.6  | 547.1 |      103.4       |
| call/1-2b-5b-2           | 36 |   500    |     235.1     | 416.6  | 531.1 |      109.4       |
| call/1-2b-3-2-1b-4b-3-.  |  9 |   300    |      16.1     | 218.1  | 237.1 |       81.9       |
```
**Floor — never late:** `floor 150 ms · at or past the punch: 0 · under floor 15/227 (6.6%) · min 16.1 · p5 138.1`. Tightest bars are all `fresh` path (cold load) at `dispatch late 17-66 ms`.

**Skew cross-check (applied correction 95 ms):** residual medians `fresh −10`, `armed +25.5`, `rewound −9` — all inside ±45, so the constant is not stale.

```
lead-ins: n 12 · end → first call median 265 ms (min 109, overlapping 0) — sound-to-sound, skew-invariant
          · end − endBy median 23.9 ms (p95 121.9) · walked over 9 — carries the 95 ms skew; reported, not acted on
combo announces: n 0 · (voiceMode minimal — the score path never runs)
token-due dispatch loop (NOT the painted ring — the ring is a frame-callback projection in
useRingBeatClock and lands within one 60 Hz frame): n 909 · fire − schedule median 45.1 p95 88.5 max 185.2
```
> That parenthetical is the single most important line in the report for anyone diagnosing drift: **`token-due` lateness (45/88/185 ms) is the JS dispatch loop, not what the athlete sees.** The painted ring is a UI-thread projection and lands within one frame.

**Ceremonies:** bell onsets 192.7 / 235.2 / 207.4 / 196.3 ms; `warn end → bell` 432 / 478 / 396 (two over the 400 target); `intro: onset 120 drift 79 (ok)`; `ducks: 0 silent birth(s)`.

**Proposals (for the ear, never applied here):**
```
| constant        | current | proposed | apply?                          | basis |
| RAIL_K_MS       |   120   |    —     | inert                           | the runner passes wordMarksFor: () => undefined — the rail is not engaged until plan C6 |
| LEAD_IN_PAD_MS  |   250   |   250    | held (skew-contaminated basis)   | lead-in end → first call onset median 265 ms over 12, none overlapping. The end − endBy figure (23.9 ms) compares corrected audio against a planned time and carries the full 95 ms skew; it is reported, not acted on. |
```

### 7.5 Current suite state — NOT green

`tools/analysis/suites/1789142947855/summary.md`, 2026-09-11, **exit 1**, `timing gate fail`, 22 drives, `sim captured-jam`, vocab numbers. 17 WARN / 5 FAIL / 0 PASS.

**Hard findings (the never-late invariant is currently broken on 3 workouts):**
- `progressive-buildup` — 1 bar with the call still sounding at the punch: `call/1-4-2-3` r3 **−42.4 ms**
- `switch-by-round` — `call/2-3-2-.` r2 **−4.6 ms**
- `uppercut-clinic` — 2 bars: `call/2-5-2-.` r1 **−5.7 ms**, `call/1-2-5b-2-1-6b-3-.` r2 **−17 ms**
- `quick-downstairs` — click-script: **10 plays cut short** by more than 150 ms
- `quick-heavy-two` — click-script: 1 play cut short

**Healthy rows** (reference for "good"): `heavy-hands` 0/281 under floor (0 %), min 152.6 / p5 249.6; `pace-pusher` 0/325 (0 %), 158.6/251.6; `quick-speed-burst` 0/184 (0 %), **225.6/339.6**; `speed-combos` 0/311 (0 %), 179.1/277.1; `three-round-fundamentals` 0/174 (0 %), 178.6/222.6.

**Worst under-floor rates:** `quick-uppercut-lane` 19/109 (17.4 %), `quick-southpaw-mirror` 19/110 (17.3 %), `switch-by-round` 27/211 (12.8 %), `quick-six-count` 10/85 (11.8 %).

**Every one of the 22 rows reports `reanchor=0`.** The anchor storm is dead.

### 7.6 Instrumentation you can grep for in a capture

- `puncheokie.cue.tokenDue` — carries `scheduledMs` + `monotonicTimeMs`
- `puncheokie.voice.observed` — real onsets and ends (GH #291)
- `puncheokie.clickScript.dispatch` — `traceId`, `dispatchAtMs`, `lateMs`, `durationMs`, `endByMs`, `firstNodeMs`, `breathMs`, `lagMs`, `monotonicTimeMs`
- `puncheokie.clickScript.skipped` — lead-in window expired before the lane freed
- `puncheokie.round.boundary` — `transition`, `roundIndex`, `workElapsedMs`, `monotonicTimeMs` (same clock as `cue.tokenDue`, so a bell's onset can be measured from the boundary it answers)
- `puncheokie.transport` — `transport started` / `transport stopped` / `transport re-anchored on audio observation` (`errorTicks`) / `transport held on backwards observations` (`held`, `worstErrorTicks`, 1 Hz summary)
- `puncheokie.metronome` — `no loop for tempo` (`division`, `swing`, `baseBpm`)
- `puncheokie.metronome.swap` — `dispatchAtMs`, `division`, `baseBpm`, `lateMs`
- `puncheokie.ring.promote` — `cueId`, `lateMs` (per bar boundary, from the worklet via `runOnJS`)
- `puncheokie.viz.batch` — one batched line per runner tick
- `puncheokie.slotDispatcher.skipped` — `slotId`, `roundIndex`, `reason` (`round-elapsed` | `retry-expired`)

Forensics are armed by `__DEV__ || EXPO_PUBLIC_VIZ_FORENSICS === '1' || isQaEnabled()` (`_useWorkoutRunner.ts:1984`). The persisted QA flag is what makes the release-like timing gate measurable without a rebuild (M39-V2 principle #18).

---

## 8. Quick-reference constant table

| Constant | Value | file:line |
|---|---|---|
| `TRANSPORT_TICKS_PER_PULSE` | 960 | `src/domain/timing/TimingEngine.ts:66` |
| `AUTHORING_STEPS_PER_PULSE` | 12 | `src/domain/timing/TimingEngine.ts:76` |
| `TICKS_PER_AUTHORING_STEP` | 80 | `src/domain/timing/TimingEngine.ts:79` |
| `MS_PER_TRANSPORT_TICK` | 1.0416666… | `programCueBridge.ts:85`, `workoutScore.ts:76`, `scoreClock.ts:29` |
| `BASE_BPM` (tick axis) | 60 | `programCueBridge.ts:82`, `workoutScore.ts:75` |
| `DEFAULT_COUNTDOWN_MS` | 5_000 | `src/domain/session/WorkoutSessionClock.ts:66` |
| `DEFAULT_PREVIEW_LEAD_MS` | 1_500 | `src/domain/programs/CueTimeline.ts:43` |
| `DEFAULT_ANNOUNCE_LEAD_MS` | 750 | `src/domain/programs/CueTimeline.ts:45` |
| `DEFAULT_GRACE_BEFORE_MS` | 200 | `src/domain/programs/CueTimeline.ts:55` |
| `DEFAULT_GRACE_AFTER_MS` | 350 | `src/domain/programs/CueTimeline.ts:56` |
| `DEFAULT_BURST_COUNTDOWN_MS` | 3_000 | `src/domain/programs/CueTimeline.ts:208` |
| `DEFAULT_LEAD_TIMES.readyToneMs` | 100 | `src/domain/programs/CueEngine.ts:56` |
| `TIMING_TIGHT_MS` | 150 | `src/domain/programs/cueScoring.ts:43` |
| `RAIL_K_MS` | 120 | `src/domain/programs/RhythmMap.ts:268` (copy: `RhythmSpine.ts:44`) |
| `DEFAULT_RESPONSE_GAP_TICKS` | 60 | `src/domain/programs/compileCue.ts:321` |
| `DEFAULT_PRELOAD_MARGIN_TICKS` | 300 | `src/domain/programs/workoutScore.ts` |
| `PHASE_CORRECTION_LARGE_TICKS` | 500 | `src/audio/MetronomeTransport.ts:86` |
| `PHASE_CORRECTION_MAX_STEP_TICKS` | 20 | `src/audio/MetronomeTransport.ts:87` |
| `LEAD_IN_PAD_MS` | **250** | `src/domain/coach/callPlacement.ts:38` |
| `CALL_PAD_MS` | 500 | `src/domain/coach/callPlacement.ts:47` |
| `CALL_DISPATCH_LAG_MS` | 71 | `src/domain/coach/callPlacement.ts:76` |
| `TECHNIQUE_CALL_LEAD_MS` | 250 | `src/domain/coach/callPlacement.ts:91` |
| `TECHNIQUE_LEADIN_LEAD_MS` | 500 | `src/domain/coach/callPlacement.ts:94` |
| `NUMBERS_CALL_LEAD_MS` | 100 | `src/domain/coach/callPlacement.ts:104` |
| `DENSE_BREATH_MS` | `{numbers:600, techniques:750}` | `src/domain/coach/callPlacement.ts:119-122` |
| `BREATH_REF_SLOT_MS` | 300 | `src/domain/coach/callPlacement.ts:125` |
| `BREATH_TRACK_GAIN` | 1.0 | `src/domain/coach/callPlacement.ts:128` |
| `MIN_BREATH_MS` | 150 | `src/domain/coach/callPlacement.ts:131` |
| `DELIVERED_BREATH_SHORTFALL_MS` | 95 | `src/domain/coach/callPlacement.ts:194` |
| `CALL_BREATH_OVERRIDES` | `{'call/1-.-.-.':340,'call/1-.-2-.':340}` | `src/domain/coach/callPlacement.ts:232-235` |
| effective breath floor | 245 (= 150+95) | derived, `callPlacement.ts:271-274` |
| `TICK_INTERVAL_MS` | 50 | `_useWorkoutRunner.ts:94` |
| `PREVIEW_LEAD_REPS` | 2 | `_useWorkoutRunner.ts:123` |
| `METRONOME_SWAP_LEAD_MS` | 400 | `_useWorkoutRunner.ts:134` |
| `AVATAR_LEAD_MS` | 375 | `_useWorkoutRunner.ts:217` |
| `STORE_THROTTLE_MS` | 250 | `_useWorkoutRunner.ts:226` |
| `RECENT_EVENT_WINDOW` | 256 | `_useWorkoutRunner.ts:232` |
| `INTRO_SEGMENT_GAP_MS` | 350 | `src/audio/introPlan.ts:41` |
| `INTRO_TAIL_PAD_MS` | 900 | `src/audio/introPlan.ts:43` |
| `INTRO_COUNTDOWN_SLACK_MS` | 1_500 | `src/audio/introPlan.ts:54` |
| `REST_RECOVERY_FRACTION` / `REST_PREVIEW_FRACTION` | 0.2 / 0.75 | `src/domain/session/restPhases.ts:43,45` |
| `SETUP_GAP_MEASURES` | 2 | `src/domain/workout/samples/clickMaps.ts:104` |
| `MAX_BURST_PUNCHES_PER_SEC` | 4 | `src/domain/workout/samples/clickMaps.ts:150` |
| `MAX_SUSTAINED_PUNCHES_PER_SEC` | 2.5 | `src/domain/workout/samples/clickMaps.ts` |
| `CLOCK_ANOMALY_MS` | 250 | `src/diagnostics/vizForensics.ts:87` |
| `FLUSH_BATCH` / `MAX_BUFFERED` / `FLUSH_INTERVAL_MS` | 64 / 512 / 500 | `src/diagnostics/vizForensics.ts:90,98,113` |
| `OBSERVER_ONSET_SKEW_MS` | 95 | `tools/analysis/observed-timing.mjs:100` |
| `EXPECTED_STRIKE_DELAY_MS` ⚠dead | 140 | `src/domain/timing/acceptance.ts:25` |
| `ACCEPT_FROM_MS` / `ACCEPT_UNTIL_BASE_MS` ⚠dead | 60 / 400 | `src/domain/timing/acceptance.ts:28,31` |

---

## 9. Pitfall checklist before you change anything here

1. **Don't tune `DELIVERED_BREATH_SHORTFALL_MS` or `LEAD_IN_PAD_MS` globally.** The 95→127 / 250→282 attempt was measured better on the median and reverted for tail regressions across 4 workouts. Use `CALL_BREATH_OVERRIDES`.
2. **Don't edit `acceptance.ts` expecting on-glass change.** It's dead; the live windows are 200/350 in `CueTimeline`.
3. **Don't "fix" `CueEngine`'s big-tick loop or the `until = Math.min(t, windowEndMs)` cap.** Tick-size invariance is pinned by ~60 tests and is a correctness property.
4. **Assert the tempo RATIO, not just ordering,** when touching `compileCue` / `programCueBridge` placement.
5. **Don't add per-transition logging to the token/ring path.** See `CLOCK_ANOMALY_MS` and the 1 Hz transport summary.
6. **Check which `VoicePolicy` you imported.** `src/domain/timing/TimingEngine.ts:241` is the V1c string union (`'per-punch' | 'per-rep' | 'announce-then-work' | 'announce-with-affirmations'`) and is what `WorkoutBlock.voicePolicy` / `CueInstance.voicePolicy` carry and what `CueAnnouncer` branches on. `src/domain/coach/VoicePolicy.ts` is the V2 three-axis interface, reachable only through `compileCue` / `workoutScore` / `coachAssetResolvers`.
7. **Never blanket-change phrase or call tempo.** A vocabulary-wide tighten was reverted the same night words started finishing ahead of punches.
8. **Verify the `'worklet'` directive location per function** — call site for `sharedAnchorCurrentTick`, inside the function for `sharedWorkElapsedMs` and `beatOrdinalAtMs`/`beatOrdinalAtMsWorklet`. Jest cannot catch a mistake here.
9. **Rename a timing constant → update `tools/analysis/timing-constants.mjs`,** or every analyzer proposal silently reports `null`.
10. **No fast refresh on F:.** Restart Metro + cold-restart the app for every edit batch.


## Open questions

- PLAYHEAD_TO_SPEAKER_MS is unmeasured and `src/audio/timingCalibration.ts` does not exist, so every onset number in every report is a playhead onset, not a speaker onset. All breath/floor tuning is therefore anchored to an uncalibrated reference. Plan C4 (one mic session) is the stated fix.
- The most recent 22-drive suite (tools/analysis/suites/1789142947855, 2026-09-11) exits 1 with the never-late invariant broken on three workouts (progressive-buildup call/1-4-2-3 r3 -42.4 ms, uppercut-clinic call/1-2-5b-2-1-6b-3-. r2 -17 ms and call/2-5-2-. r1 -5.7 ms, switch-by-round call/2-3-2-. r2 -4.6 ms), plus 10 truncated plays on quick-downstairs. All four tightest-bar paths are `fresh` (cold load). Was this ever closed after 2026-09-11, or is it the open ledger a new session inherits?
- `expandCountScoredBlock` (CueTimeline.ts:485) clamps windowStartMs with only Math.max(0, ...) while expandBlock (:412-414) also applies Math.min(workDurationMs, ...). assertWindowsClamped only tests `windowStartMs < 0 || windowEndMs > workDurationMs`, so an inverted window from a count-scored block past the bell would pass. Should the clamp be made symmetric, the assertion widened to catch start > end, or both?
- The '867 ms -> 1 ms' framing in project memory: 867 ms is real (compileCue.ts:94) but no sub-millisecond post-fix figure exists anywhere in the repo. The executable guarantee is +/-2 ticks (~2.08 ms) in workoutScore.test.ts:256. Where did 0.98 ms come from, and should the memory note be corrected to the test tolerance?
- The metronome LOOP wav is selected at coachTempo.baseBpm while the TRANSPORT rate is bpmForRecipe (baseBpm x division x globalSpeed). For the four division-2 maps that means a 60-BPM 1000 ms loop under a 120-BPM tick clock. Is that intentional (the loop is a texture, the transport is the clock) or a latent mismatch of the class that produced ~500 transport holds/sec?
- `timing-constants.mjs` labels `leads.source` as callPlacement.ts even though METRONOME_SWAP_LEAD_MS and AVATAR_LEAD_MS are read from _useWorkoutRunner.ts (lines 152-153). Worth correcting so the provenance field is trustworthy?
- The startPadMs sidecar is fully dead (no references in src/, clip-shifts.json empty, PhraseAsset type deleted) yet three live files still reference it: .claude/skills/cadence-lab/SKILL.md:95, tools/voice/cadence_audit.py:134, and docs/audio-corpus.md:40 (which falsely claims the runner reads it). Prune the sidecar and fix the docs, or keep it staged for plan C6?
- Plan C6 (wire word marks on call clips + placement by last-word end) is the gate on the cadence rail ever becoming load-bearing. Word onsets/ends exist for 562 of 776 clips in phraseTimingManifest.ts, but those clips belong to the RETIRED phrase bank, not the live 736-clip click-script bank, which has no marks at all. Is C6 still the plan, and would it require re-rendering the click bank with marks?
