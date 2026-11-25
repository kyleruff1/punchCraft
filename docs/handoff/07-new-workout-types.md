# Roadmap: adding non-boxing workout types on top of the boxing engine

## 0. Three findings that set the whole plan

**(1) The scoring half of the engine is ALREADY discipline-neutral — and nobody noticed.**
`CueTimeline.ExpectedPunch` (`F:/punchCraft/src/domain/programs/CueTimeline.ts:71-81`) is the contract that flows into every matcher, scorer, summary and DB row. Its entire shape is:

```ts
export interface ExpectedPunch {
  tokenIndex: number
  hand: 'left' | 'right'
  type?: PunchType        // "never something observed"; unverified on this hardware (D12)
}
```

There is **no `number`, no `body`, no notation**. And `CueMatcher.outcomeFor` (`src/domain/programs/CueMatcher.ts:224-236`) begins `if (event.hand !== expected.hand) return 'hand-mismatch'` and then short-circuits on `if (!tierScoresTechnique(this.tier)) return 'matched'` — which on FightCamp v1 is always true. So **everything from `CueInstance.expectedPunches` downward needs zero change for a new discipline.** The only thing a discipline must supply to the scored path is *"which physical hand should fire at token index i."*

**(2) The number→hand and number→label funnels are tiny.** `resolveHand` has exactly **one** production caller (`CueTimeline.ts:367`). `strikeFor` has exactly **one** (`compileCue.ts:380`). `parseCombo` has exactly **two** real lowering callers (`samples/authoring.ts:96` and `:246`); every other call site is a self-check or a tally. The full set of `token.number` / `token.body` reads under `src/domain/programs/` is **12 lines across 7 files** (listed in §1.B). The 2311-line runner touches punch numbers at exactly **2** lines (`_useWorkoutRunner.ts:696`, `:850`).

**(3) There is already a non-boxing surface on this tracker, and it chose to FORK.** `src/domain/instrument/` (the Puncheoke instrument, 29 files) re-declared its own `StrikeToken` (`gestureSchema.ts:63-76`, byte-identical 12 tokens) and its own `StrikeFamily` with **divergent values** — `'straight' | 'hook' | 'uppercut'` (`strikeArticulationCatalog.ts:27`) versus the workout engine's `'jab' | 'cross' | 'hook' | 'uppercut'` (`strikeCatalog.ts:56`) — plus its own `PhysicalHand = 'physical-left' | 'physical-right'` (`strikeArticulationCatalog.ts:30`). It reuses **nothing** above the tracker: grepping `src/domain/instrument` + `src/app/(tabs)/puncheokie` for `CueTimeline|expandTimeline|ProgramRound|WorkoutSessionClock|CueEngine` returns **zero hits**; the only shared import is `getTrackerKeepaliveSource` (`jam.tsx:57`). The fork is already paid for once and it already produced a drifted enum. Do not pay it twice.

**Baseline gate (run 2026-11-25):** `npx jest src/domain/workout src/domain/programs src/domain/strikes` → **51 suites, 1645 tests, 22 snapshots, all pass** in 13.7 s. That is the green bar every step below must hold.

---

## 1. Coupling inventory

### A. Tier 0 — the vocabulary root (`src/domain/workout/WorkoutTokens.ts`, 372 lines, import-free)

| Coupling | file:line | What it hardcodes |
|---|---|---|
| `PunchNumber = 1 \| 2 \| 3 \| 4 \| 5 \| 6` | `WorkoutTokens.ts:25` | A 6-symbol alphabet |
| `Stance = 'orthodox' \| 'southpaw'` | `WorkoutTokens.ts:28` | Boxing stance names (D2 retired a third value) |
| `BlockStance = 'inherit' \| 'orthodox' \| 'southpaw' \| 'switch'` | `WorkoutTokens.ts:34` | same |
| `DefenseCommand` (duck/bob-weave/slip/roll/pull) | `WorkoutTokens.ts:36` | Boxing defense |
| `FootworkCommand` (pivot/step-off/circle/cut-off-ring/reset) | `WorkoutTokens.ts:37` | Boxing footwork |
| `CoachCommand` (double-up/put-it-on-em/touch-and-go/breathe/hands-up) | `WorkoutTokens.ts:38` | Boxing corner idiom |
| `WorkoutToken` punch variant `{kind:'punch'; number:PunchNumber; body:boolean; …}` | `WorkoutTokens.ts:41` | "a punch has a number and a head/body target" |
| `BlockKind` — 10 values incl. `'defense-counter'`, `'footwork-exit'`, `'open-pressure'`, `'coast'` | `WorkoutTokens.ts:75-94` | Boxing-named block taxonomy |
| `isPunchNumber` range check `n >= 1 && n <= 6` | `WorkoutTokens.ts:241` | Alphabet size, enforced at parse |
| `parseCombo` punch regex `/^(\d+)(b?)$/i` + `'.'` rest + the three word-maps | `WorkoutTokens.ts:245-330` | The notation **grammar** |
| `DEFENSE_WORDS` / `FOOTWORK_WORDS` / `COACH_WORDS` spaced spellings | `WorkoutTokens.ts:206-227` | Notation↔enum word bridge (`'step off'` → `'step-off'`) |
| `formatCombo` body suffix `'b'` | `WorkoutTokens.ts:355` | serialization |
| `punchTokens()` — "the sole scored token kind (D4)" | `WorkoutTokens.ts:369-371` | only punches score |

### B. Tier 1 — derivations (small, single-caller)

| Coupling | file:line | Notes |
|---|---|---|
| `LEAD_NUMBERS = {1,3,5}` + `isLeadNumber` | `StanceMapper.ts:39-43` | the parity rule |
| `resolveHand(number, stance)` | `StanceMapper.ts:52-57` | **one** prod caller: `CueTimeline.ts:367` |
| `resolveSequence` / `handSequence` | `StanceMapper.ts:100-131` | **DEAD** — no production caller (see §9) |
| `familyFor`: 1→jab, 2→cross, 3\|4→hook, 5\|6→uppercut | `strikeCatalog.ts:106-109` | |
| `handFor`: `number % 2 === 1 ? 'lead' : 'rear'` | `strikeCatalog.ts:111-114` | the parity rule, second copy |
| `nodeIdFor`: `node.${n}` / `node.${n}b` | `strikeCatalog.ts:120-122` | 12 ring nodes |
| `TECHNIQUE_FULL` / `TECHNIQUE_COMPACT` / `NUMBER_WORD` | `strikeCatalog.ts:128-152` | spoken labels |
| `spokenFor` body form `` `${NUMBER_WORD[n]}-bee` `` | `strikeCatalog.ts:154-163` | the fused-Xbee rule |
| `STRIKE_CATALOG` (12 frozen entries) + `STRIKE_TOKENS` | `strikeCatalog.ts:185-205` | |
| `strikeFor(number, body)` | `strikeCatalog.ts:213-216` | **one** prod caller: `compileCue.ts:380` |
| `IMPLIED_TYPE {1,2:straight 3,4:hook 5,6:uppercut}` | `CueTimeline.ts:216-223` | only consumer of `type?` |
| `expectedPunches.push({tokenIndex, hand: resolveHand(...), type: IMPLIED_TYPE[...]})` | `CueTimeline.ts:362-374` | **THE seam** — the one function that turns a token into the scored contract |
| `constraintFor` → `last.number % 2 === 1 ? 'lead' : 'rear'` | `CueTimeline.ts:518` | parity, third copy |
| `allowedPattern` build `` `${t.number}${t.body?'b':''}` `` | `CueTimeline.ts:498` | |
| `strikeTokenFor(number, body)` → `'1'`/`'1B'` | `programCueBridge.ts:117-119`, used `:194` | |
| `avatarFamilyId` = `` `avatar.${n}${body?'b':''}` `` | `compileCue.ts:404` | |
| `token.number % 2 === 1` | `RhythmSpine.ts:305` | parity, fourth copy |
| notation key `` `${t.number}${t.body?'b':''}` `` | `RhythmSpine.ts:354`, `workoutScript.ts:324` | |
| `PUNCH_ASSETS`/`PUNCH_BODY_ASSETS` `1..6`/`1b..6b` + `throw RangeError` on out-of-range | `src/domain/coach/vocabulary.ts:17-33`, `:62-66` | **widening trap**: throws, not degrades |

### C. Tier 2 — content (the bulk by line count, zero structural weight)

| Coupling | file:line / size |
|---|---|
| `MOTIFS` legacy library, 32 entries | `comboLibrary.ts:65-110` |
| `motifsFor()` hard filter (role, length, complexity, body, `enabledPunches`) | `comboLibrary.ts:132-156` |
| `COMBO_CORPUS` 60 combos + `BUILD_UP_SETS` 18 ladders + `GENERATOR_RULES` GR01-GR10 | `corpus/comboCorpusV1.ts` (3307 lines) + `.json` |
| `canonicalNotation` / `complexityFor` / `defaultOffsets` | `corpusMotifs.ts:62-110` |
| `CLICK_MAPS` 10 maps, **164 rows** of authored boxing bars + spoken copy | `samples/clickMaps.ts` |
| `QUICK_CLICK_MAPS` 12 quick maps | `samples/quickWorkouts.ts` |
| `CHUNKS` library — boxing-named chunk ids (`jab-cross-hook-cross-x18`) | `samples/chunks.ts` |
| `SampleWorkoutKey` closed union (11 keys + `QuickWorkoutKey`) and `SAMPLES: Record<SampleWorkoutKey, …>` | `samples/index.ts:34-46`, `:53` |
| `SETUP_PATTERNS` 21 patterns, `familyPatternFor` hardcoding 1/2=straights, 3/4=hooks, 5/6=uppercuts, `'square'={1,2,3,4}` | `setupCallouts.ts:168-186` |
| Per-sample wiring (×12 files, ~90 lines each) | e.g. `samples/bodyWork.ts:51` tally loop |

### D. Tier 3 — generator heuristics baked into `roundFill.ts` (735 lines)

| Coupling | file:line |
|---|---|
| lead/rear shares via `n % 2` | `roundFill.ts:352-353` |
| ladder weight `w *= 1 + 3 * shares.jab` | `roundFill.ts:369` |
| `allJab` detect `t.replace('b','') === '1'` | `roundFill.ts:461-464`, `:680` |
| ceremony pattern pick `co-jab-volume` / `co-volume` | `roundFill.ts:465` |
| `bodyVariationOf()` — scans `/^[1-6]$/`, appends `'b'` | `roundFill.ts:246` |
| `jabShareOf()` sort key in the coverage-repair pass | `roundFill.ts:601`, `:610` |
| power-coast regex `/^(1b?\|2b?\|1-2\|2-1)$/` | `roundFill.ts:685-686` |
| `recipe.enabledPunches[0] ?? 1` used as "the jab" in `buildAuxRound` | `generateWorkout.ts:48` |
| `isLeadNumber` bias weighting ×1.4 | `recipeSummary.ts:91-92` |

### E. Tier 4 — voice corpus and render tools

| Coupling | file:line |
|---|---|
| `NUMBER_WORDS` / `TECHNIQUE_WORDS` / `MOVEMENT_WORDS` + `spokenFor` fused-bee | `tools/voice/prosody.mjs:31,44,53,74-107` |
| `callText(motif)` + `CALL_NUMBER_OVERRIDES` | `tools/analysis/gen-workout-scripts.ts:~300-330` |
| `callTextTechnique` + `CALL_TECHNIQUE_OVERRIDES` (6 entries) | `gen-workout-scripts.ts:226-248` |
| `NAMES` / `WALKOUTS` tables, all boxing prose | `gen-workout-scripts.ts:30-73` |
| `CALL_CLIP_OVERRIDES` (5 plural-pattern entries) | `tools/voice/make-click-script-clips.mjs:181` |
| `syllableUnits` counting `uppercut=3, upper=2, body=2, '-bee'=2` | `make-click-script-clips.mjs:218-226` |
| `clickScriptManifest.ts` — **736 clips** keyed `call/<motif>`, `lead-in/<id>/rNsM`, `rest/<id>/rN` | generated, 242 KB |
| `comboAnnounceManifest.ts` — **218 clips** keyed by notation × vocabulary | generated |
| `calloutManifest.ts` — **21** clips, every id boxing-named (`theme-jab-volume-ladder`, `theme-uppercut-cascade`, …) | generated |
| `sustainedManifest` 24, `techniquesStandaloneManifest` 12, `coastManifest` 39 | all boxing-worded |

### F. Tier 5 — UI / presentation

| Coupling | file:line |
|---|---|
| `renderToken` switch on `token.kind` → `PunchToken`/`DefenseToken`/`FootworkToken`/`RestSlot` | `src/components/workout/CueStage.tsx:147-197` (the one dispatch point) |
| `handHintFor` → `'L'`/`'R'` from `expected.hand` | `CueStage.tsx:126-130` |
| `PunchToken` renders the literal digit; a11y label `` `Punch ${number}` ``, `'to the body'`; testID `punch-token-${n}${b?'b':''}` | `PunchToken.tsx:83-85`, `:99` |
| `PUNCHES` label table `'Jab / 1' … 'Rear uppercut / 6'`, plus `DEFENSE`/`FOOTWORK`/coach tables | `EnablementMenu.tsx:44-60` |
| `PUNCH_NAMES` | `recipeSummary.ts:30-37` |
| `punchAvatarFrames` — **24 PNGs** (12 pairs) keyed `(number, body)`, + `guard.png` | `punchAvatarManifest.ts`; assets at `assets/avatar/punch/` |
| avatar frame generator (source art `assets/branding/Punch Step1s|Step2s/`) | `tools/avatar/make_punch_frames.py` |
| Three tabs: `velocity-lab`, `punchcraft`, `puncheokie` | `src/app/(tabs)/_layout.tsx:314-336` |

### G. Tier 6 — `WorkoutRecipe` (`src/domain/workout/WorkoutRecipe.ts`)

Boxing-specific fields: `totalPunchGoal:56`, `defaultStance:58`, `stanceMode:59`, `bias:65` (`'lead'|'rear'|'left'|'right'`), `enabledPunches:69`, `bodyShotPercent:70`, `enabledDefense:71`, `enabledFootwork:72`, `enabledCoachCalls:73`, `maximumComboPunches:76`, `defenseFrequency:77`, `footworkFrequency:78`, `commandVocabularyStyle:102`, `voiceVocabulary:107`. **There is no `disciplineId` field** — adding one is step 1 of the plan.

### H. Tier 7 — storage (almost free)

`punch_events` and `cue_results` are boxing-*named* but their columns are exactly what the tracker gives: hand, timestamp, velocity, acceleration. `cue_results` PK is `(session_id, generated_workout_id, block_id, repeat_index, token_index)` (`005_cue_result_repeat_index.ts:72`) — token indexes, not punch numbers. `workout_runs` stores `realized_tokens_json TEXT` + `generated_workout_id TEXT` (`007_workout_runs.ts:91-97`). **No migration is needed for a new discipline.** `expected_type` is already always NULL on this hardware (`004_workouts.ts`).

---

## 2. What is already generic and needs NO change

Verified by reading, not inferred:

- **The whole scored path below the timeline**: `CueEngine.ts` (walks `tokenOffsetsMs` + `expectedPunches`, dedupes by `strikeId`), `CueMatcher.ts`, `LiveCueMatcher.ts`, `cueScoring.ts` (261 lines, zero reads of `number`/`body`), `workoutSummary.ts`, `capabilityTier.ts`, `persistWorkoutSession.ts`.
- **`validateGeneratedWorkout`** (`GeneratedWorkout.ts:99-152`) — purely structural. Its only semantic rule is `countsTowardGoal === (kind === 'round')`. Note `token-offsets-not-ordered` uses `<` not `<=` (`GeneratedWorkout.ts:69`), so **equal beat offsets are legal** → simultaneous two-handed actions are structurally expressible (but see §7).
- **Time**: `WorkoutSessionClock.ts`, `restPhases.ts`, `cadence.ts` (`beatsToMs`, `blockDurationMs`, `bpmForRecipe`), `roundSchedule.ts` (`ROUND_WORK_MS=240_000`, `REST_MS=60_000`, `SHAPES`), `TimingEngine.ts` transport (`TRANSPORT_TICKS_PER_PULSE=960`), `scoreClock.ts`, `SharedWorkClock.ts`, `beatProjection.ts`, `MetronomeTransport.ts`, `SlotDispatcher.ts`.
- **Lowering**: `samples/authoring.ts` — `layBlocks:88`, `blockPunchCount:158`, `roundPunchCount:165`, `blocksSpanMs:170`. The *only* discipline dependency is that `spec.notation` must be parseable.
- **Click-map measure arithmetic**: `measuresPerRep:84`, `breathBeats:89`, `rowMeasures:93`, `setupMeasuresForRow:113`, `clickSpecs:119-141`, `SETUP_GAP_MEASURES=146`. `clickSpecs` is 100% vocabulary-agnostic — it just forwards `row.motif` as `notation`.
- **Call placement**: all of `src/domain/coach/callPlacement.ts` (`LEAD_IN_PAD_MS=250` at :38, `CALL_PAD_MS=500` at :47, `CALL_DISPATCH_LAG_MS=71` at :76, `breathForBar` at :250). It works on slot keys and clip durations, never on punch semantics.
- **Allocation & determinism**: `goalAllocation.ts` (largest-remainder), `punchGoals.ts` (`GOAL_TIERS`, `FOCUS_FACTORS`), `seededRandom.ts`, `planMutation.ts`, `mapValidation.ts` (`coverageAudit`, `silenceAudit`), `chunks.ts` + `composeFromChunks.ts` (chunk linking is vocabulary-agnostic apart from the motif string).
- **Pace caps are physiology, not boxing**: `MAX_BURST_PUNCHES_PER_SEC = 4` (`clickMaps.ts:150`), `MAX_SUSTAINED_PUNCHES_PER_SEC = 2.5` (`:151`) — reusable as "max actions/sec" for any hand discipline.

---

## 3. The abstraction: one injected resolver, not a type rewrite

### The seam

`expandTimeline` already takes an options bag — `ExpandOptions` at `CueTimeline.ts:63-67`. Add one field to it. The whole abstraction is:

```ts
// NEW FILE: src/domain/workout/ActionVocabulary.ts  (import-free, like WorkoutTokens)
export interface ActionVocabulary {
  readonly id: string                                   // 'boxing' | 'speedbag' | 'drumline' | …
  /** Notation grammar. Boxing's impl is today's parseCombo/formatCombo verbatim. */
  parse(notation: string): WorkoutToken[]
  format(tokens: readonly WorkoutToken[]): string
  /**
   * THE scored contract. null means "this action cannot be observed by the
   * tracker" → the token becomes display-only instead of a scored slot.
   */
  handFor(token: Extract<WorkoutToken, {kind:'punch'}>, stance: Stance): 'left' | 'right' | null
  /** Optional prescription family; may be undefined (nothing verifies it — D12). */
  familyFor?(token): PunchType | undefined
  /** Presentation. */
  nodeIdFor(token): string
  labelFor(token, vocabulary: 'numbers' | 'techniques'): { call: string; compact: string }
  glyphFor(token): { text: string; badge?: string; avatarKey?: string }
  /** Clip/slot key for the motif bar — today `t.number + (body?'b':'')`, '.' for rest. */
  slotCodeFor(token): string
}

export const VOCABULARIES: Record<string, ActionVocabulary>   // registry, default 'boxing'
```

Then **one** branch change at `CueTimeline.ts:362-374`:

```ts
const hand = vocab.handFor(token, ctx.effectiveStance)
if (token.kind === 'punch' && hand !== null) {
  expectedPunches.push({ tokenIndex, hand, ...(type ? { type } : {}) })
} else {
  displayOnlyTokenIndexes.push(tokenIndex)
}
```

That is the entire load-bearing change to the scored path, because of finding (1). `recipe.disciplineId?: string` on `WorkoutRecipe` selects the vocabulary; absent → `'boxing'`, so every one of the 1645 existing tests is byte-unchanged.

### But the cheap path first: the 1-6 channel is an opaque 12-symbol alphabet

Before building the registry, notice what boxing's vocabulary *structurally* is:

- a 6-value code, where **odd = lead, even = rear** (`StanceMapper.ts:39`, `strikeCatalog.ts:113`, `CueTimeline.ts:518`, `RhythmSpine.ts:305` — four copies of the same parity rule)
- × a boolean variant (`body`)
- = 12 symbols, each mapping to one ring node, one avatar frame pair, one spoken word, one of two physical hands.

**Any discipline expressible as ≤6 alternating-hand roles with an optional binary variant needs NO type change, NO new interface, and NO engine change.** It needs only new *tables*: labels, glyphs, avatar frames, clip bank, content library. Call that a **Vocabulary Pack (Tier A)**.

This matters enormously for sequencing: Tier A ships without touching `WorkoutTokens.ts`, `StanceMapper.ts`, `CueTimeline.ts`, `CueMatcher.ts` or any migration — and it is the right MVP. Tier B (the registry above) is only needed when a discipline breaks one of the three structural assumptions:

| Assumption | Breaks when | Cost |
|---|---|---|
| ≤6 role codes | 7+ distinct actions | widen `PunchNumber` + `isPunchNumber` (`WorkoutTokens.ts:25,241`), regenerate every clip key |
| odd=lead / even=rear | hands don't alternate by parity (e.g. lead-hand-only drill with 4 variants) | the 4 parity copies + `handFor` injection |
| one binary variant (`body`) | 3+ variants per role | `body: boolean` → a variant code; touches `formatCombo`, every notation key, every clip id |

---

## 4. What a new discipline must supply

| Layer | Deliverable | Tier A (pack) | Tier B (registry) |
|---|---|---|---|
| Token grammar | notation spelling, rest symbol, word-maps | reuse digits + `b` + `.` as-is | own `parse`/`format` |
| Matching rule | code→hand | reuse parity | own `handFor`, may return `null` |
| Labels | 6 × {full, compact} + body form + a11y strings | new tables mirroring `strikeCatalog.ts:128-152` + `prosody.mjs:31-44` | same |
| Glyphs | token face (digit or symbol), badge, `node.*` ids | `PunchToken` needs a label prop instead of rendering `number` directly | same |
| Avatar | 12 frame pairs (24 PNGs) + guard | new source art through `tools/avatar/make_punch_frames.py` | same |
| Clip set | per-bar calls, section lead-ins, rest scripts, walkout, themes | see §6 | same |
| Content | one `ClickMap` + one `GeneratedWorkout` sample file | ~90 lines, copy `samples/bodyWork.ts` | same |
| Registry entry | `SampleWorkoutKey` union + `SAMPLES` record | `samples/index.ts:34-46` | plus `VOCABULARIES` |
| Block kinds | which of the 10 kinds apply | reuse `'repeated-combo'` only (what all 22 shipped workouts use) | optionally add kinds |

**What a new discipline must NOT need to supply:** a generator. `generateWorkout`/`roundFill` is only reached when the athlete picks *no* sample (`live.tsx:301`); all 22 shipped workouts are click maps. Leave `roundFill`'s jab-share heuristics (Tier 3 above) entirely alone for the MVP and for a long time after.

---

## 5. Minimum viable new workout type, and the exact sequence

**MVP definition:** one 2-round, 4:00-per-round click-map workout in a non-boxing vocabulary, running on the existing runner, with per-bar calls and section lead-ins in **one** vocabulary (numbers only), scored as a hand-sequence match. Pattern it on `src/domain/workout/samples/bodyWork.ts` (90 lines) and the quick-workout shape in `samples/quickWorkouts.ts`.

### Step-by-step (each step ends green on the baseline gate)

**Step 1 — `disciplineId`, inert.** Add `disciplineId?: string` to `WorkoutRecipe` (`WorkoutRecipe.ts`, beside `voiceVocabulary:107`) and default it to `'boxing'` in `defaultRecipe()` (`:193-241`). Nothing reads it yet. *Gate: 1645 tests unchanged.* Do NOT bump `GENERATOR_VERSION` (currently `'1.2.0'`, `versions.ts`) — an optional unread field cannot change generator output, and bumping it re-keys the RNG seed `${seed}|${generatorVersion}` and every determinism snapshot.

**Step 2 — lift the label tables behind a lookup.** Create `src/domain/workout/actionLabels.ts` exporting `labelsFor(disciplineId)` returning `{ TECHNIQUE_FULL, TECHNIQUE_COMPACT, NUMBER_WORD, PUNCH_NAMES, MENU_LABELS }`. Re-point, one file per commit: `strikeCatalog.ts:128-152`, `recipeSummary.ts:30-37`, `EnablementMenu.tsx:44-60`. Boxing entry holds today's exact values. *Gate: snapshots must not move — 22 of them cover this.*

**Step 3 — make `PunchToken` label-driven.** It currently renders `number` as text and builds `` `Punch ${number}` `` (`PunchToken.tsx:83`). Add optional `glyph?: string` / `a11yNoun?: string` props, supplied by `CueStage.renderToken` (`CueStage.tsx:148-166`) from the label lookup. Keep `testID` generation as-is so `src/components/workout/__tests__/tokens.test.tsx` still matches.

**Step 4 — the vocabulary pack scaffold.** Add `src/domain/workout/vocabularies/<id>/` with `labels.ts`, `avatarKeys.ts`, `clickMap.ts`, `workout.ts`. Register in `samples/index.ts` (`SampleWorkoutKey:34`, `SAMPLES:53`, `ORDER:~140`). **Beware:** `compose()` in `samples/composeFromChunks.ts` **throws at module load** on a mis-filled round — a bad measure budget fails the whole app bundle import, not a test. Author the new map as a literal `ClickMap` (like `CLICK_MAPS`), not as chunk links, for the MVP.

**Step 5 — satisfy the measure budget exactly.** `clickMapsSelfCheck` (`clickMaps.ts:160`) requires `sum(rowMeasures) + sum(setupMeasures) === bpm` **exactly** per round (a 4:00 round at B BPM holds exactly B measures), and enforces `MAX_BURST_PUNCHES_PER_SEC = 4` (`:150`) / `MAX_SUSTAINED_PUNCHES_PER_SEC = 2.5` (`:151`), digit-free spoken copy, and rest scripts. Extend it to iterate the new map — and route through `allClickMaps()` (`samples/allClickMaps.ts`), never `CLICK_MAPS` directly; that file's header records three tools that previously walked only the literal maps and silently skipped composed workouts.

**Step 6 — script texts.** Extend `tools/analysis/gen-workout-scripts.ts`: add the new workout to `NAMES` (`:30`) and `WALKOUTS` (`:44`), and give `callText`/`callTextTechnique` (`:~300`, `:238`) the new word table. `--corpus` output **is** the render list, executed live by the renderer, so the doc and the clips cannot drift.

**Step 7 — render the clips.** `node tools/voice/make-click-script-clips.mjs --only=<new-workout-id>`. See §6 for volume. Then run the QA loop (speaker audit + token audit; rulebook steps 3-4 cannot run — see §9).

**Step 8 — avatar frames.** 12 new source-art pairs into `assets/branding/`-style folders, then `F:/voice-tools/venv/Scripts/python.exe tools/avatar/make_punch_frames.py`. **Interim fallback:** ship the MVP with `guard.png` for every frame rather than boxing art under a non-boxing label — a wrong avatar is worse than a static one. The avatar rides `SharedTransportAnchor`, so a missing frame is cosmetic, not a freeze.

**Step 9 — on glass.** Metro restart + app cold restart (no fast refresh on `F:`, ever). Drive with `tools/analysis/observed-timing.mjs`; document closer/farther in the workout's GH issue.

**Only then, if the alphabet or the parity rule actually breaks: Step 10 — the registry.** Land `ActionVocabulary` (§3), thread it through `ExpandOptions` (`CueTimeline.ts:63`) and the one branch at `:362-374`, and have `samples/authoring.ts:96` call `vocab.parse` instead of the bare `parseCombo`. **Fix `vocabulary.ts:62-66` first** — `comboPhraseAssets` throws `RangeError` on any number outside 1-6, so a widened alphabet hard-crashes `CueAnnouncer.ts:593` and `workoutScript.ts:391` before anything else fails.

---

## 6. Voice corpus cost

### Exact current corpus (counted from the manifests, 2026-11-25)

`clickScriptManifest.ts` holds **736 clips covering 746 slots**, split perfectly symmetrically:

| kind | slots / vocabulary | clips / vocabulary | total clips |
|---|---|---|---|
| `lead-in` | 262 | 258 | 516 |
| `rest` | 41 | 41 | 82 |
| `call` | 70 | **69** | 138 |
| **total** | 373 | 368 | **736** |

(The prior survey's "517 lead-in / 138 call / 82 rest" is off by one on lead-in; the truth is 516/138/82.)

### The cost model — three different scaling laws

1. **`call` clips scale with DISTINCT MOTIFS, not workouts.** **70 distinct call slots** cover all **164 rows across 22 workouts**. Clips are deduped by text (`make-click-script-clips.mjs:102-130`), so 70 slots → 69 wavs per vocabulary. A new discipline with a 10-motif bar library costs **10 call clips per vocabulary**, forever, regardless of how many workouts reuse them.
2. **`lead-in` clips scale with SECTIONS and barely dedupe** — 262 slots → 258 clips, i.e. ~12 per workout, essentially 1:1. This is the dominant cost per new workout.
3. **`rest` clips** = (rounds − 1) per workout. 41 across 22 workouts.

### MVP quote (one 2-round workout, ~4 sections/round, ~8 distinct motifs, numbers only)

| item | count |
|---|---|
| per-bar calls | ~8 |
| section lead-ins | ~6 (section 1 of round 1 is pre-bell, owned by the walkout) |
| rest script | 1 |
| walkout | 1 (`gen-workout-scripts.ts:44` `WALKOUTS`) |
| **total new wavs** | **≈16** |

Adding the techniques vocabulary doubles it (**≈32**). Reusable as-is: bells, `INTRO_SEGMENTS` `intro-rounds-N` and `intro-program-<tier>-<cadence>` (52 clips, generic wording), `recoveryManifest` (86), `metronomeAssets` (14), silence tracks. **Not reusable:** all 21 `calloutManifest` theme clips (every id is boxing-named: `theme-jab-volume-ladder`, `theme-uppercut-cascade`, …), `coastManifest` (39), `sustainedManifest` (24), `techniquesStandaloneManifest` (12), `comboAnnounceManifest` (218).

### Render-work gotchas that will bite

- **ffmpeg is not on PATH.** `findFfmpeg()` falls back to a **hardcoded** `…/Gyan.FFmpeg_…/ffmpeg-9.0-full_build/bin/ffmpeg.exe`. A winget upgrade past 9.0 silently breaks every render script.
- **Chatterbox is seedless** — same job, different-sounding take each run. `speaker_audit.py` (outlier at z < −1.5) is mandatory after every batch.
- **Chatterbox elides a syllable on 3+ consecutive identical words, and Whisper hallucinates it back**, so `asrExact: true` passes on a false transcript. If the new vocabulary has pump bars (`X-X-X-X`), budget a plural rename (`'Four ones!'`) and `--attempts=30`. Five such overrides exist at `make-click-script-clips.mjs:181`.
- **`CALL_CLIP_OVERRIDES` breaks the id↔text invariant.** Ids are `sha1(PRE-override text)`, so `--missing-only` sees an overridden wav as present and never re-renders it. Re-render overridden slots with explicit `--only-keys=…`.
- **`persona.mjs`'s flat constants follow `ACTIVE_PERSONA` and silently ignore `--persona=`.** This has shipped the wrong voice twice. Active persona is `cornerman3` (`tools/voice/personas.mjs`), 48 kHz, `tempoCalibration 1.35`, texture `broadcast-dry-gentle-bright`.
- **New wavs go in an EXISTING directory.** A fresh folder under `assets/voice/` breaks Metro's Windows file map and does not self-recover; restart with `npx expo start --dev-client --port 8081 --clear`. Put new click-script clips in `assets/voice/click-scripts/cornerman3/`.
- `findClickScript(slot, 'techniques')` **falls back to the numbers clip**, so a half-rendered techniques bank degrades to numeric copy invisibly. `samples/__tests__/clickCallFit.test.ts` is the only gate, and it only fires once at least one techniques call is on disk.

---

## 7. Hard constraints (these decide which disciplines are even possible)

- **H12 — the tracker reports hand + timestamp + velocity, and nothing else.** The payload type byte "carries no device-portable meaning at all" (`docs/puncheokie-ux-workout-engine.md:23`). `mapType()` always returns `'unknown'`; the tier is pinned at `'hand-timestamp'` (`src/protocol/TrackerPunchEventSource.ts:102-107`), `tierScoresTechnique` is false, `'type-mismatch'` is unreachable. **Consequence: a new discipline's distinct actions are verified ONLY as a left/right sequence.** Two actions sharing a hand pattern are indistinguishable to the app — exactly as `1-2-3` and `1-2b-3` are today. The cue *prescribes*; the tracker *confirms a hand*.
- **D13 — the acceleration transmit floor (NOT "H13" — there is no H13 anywhere in the repo; grep returns only binary PNG/WAV false positives).** The authority is **D13** at `docs/puncheokie-ux-workout-engine.md:1069` plus the "Also observed — transmit floor" paragraph at `docs/protocol/hypotheses.md:291`: ten deliberately soft uppercuts produced **exactly 1 event**, and Hykso's "not a real punch" bytes 0/5 never appeared, so the cutoff is below the transmit stage. `outcome: 'missed'` is therefore **ambiguous by construction** — "did not throw" and "threw too softly to exist" are the same absence of evidence, and `004_workouts.ts:76` records that neither may be shown as failure. **Consequence: any discipline built on soft, slow or controlled movement (mobility, yoga, tai-chi, shadow technique at low intensity) cannot be scored at all.** Confidence is medium (one set, blue tracker disconnected after) — a repeat on a charged tracker is still owed.
- **D16 — time-critical speech is pre-rendered offline, never synthesized at runtime** (`docs/puncheokie-ux-workout-engine.md:1104`, §18.2 note at `:557`). No synthesis, no network at workout time. **Consequence: a new discipline's vocabulary is CLOSED at build time.** Nothing can be voiced that was not rendered. Note the doc names Kokoro-82M; the actual pipeline is **Chatterbox** (GPU, `F:/voice-tools/venv/Scripts/python.exe`, override `CHATTERBOX_PYTHON`) — the doc is stale on the engine, not on the rule.
- **Simultaneous two-handed actions are a trap.** `validateGeneratedWorkout` allows equal `beatOffset`s (`GeneratedWorkout.ts:69`, `<` not `<=`), so a simultaneous pair is *expressible*. But `CueMatcher` sorts by event time and fills "the earliest unfilled slot" (`CueMatcher.ts:138-156`), with a hand mismatch becoming an extra that leaves the slot open (D18, `:161-166`). An authored `[left, right]` at the same offset where the right glove happens to transmit first produces two extras and two misses. **Do not author simultaneous actions without first changing the matcher's slot rule.**
- **Trackers must be BONDED.** Unpaired, the glove's SMP Security Request + Android's 30 s timeout kills every link at ~37 s, in every app. This is a manual OS step (Android Settings → Bluetooth → Pair new device; they advertise as **"FightCam"**, not "L Punch"/"R Punch") and it is **documented nowhere in the repo** — only in `C:/Users/kyler/.claude/projects/C--Users-kyler-punchlab/memory/project-tracker-duty-cycle.md`. Verify with `adb shell dumpsys bluetooth_manager | grep -A3 "Bonded devices"`.
- **Hand comes from the MAC, not the payload.** `KNOWN_TRACKERS` hardcodes `D7:34:B4:27:D5:84` → left/blue and `EA:69:2D:9C:FD:53` → right/red (`src/ble/knownTrackers.ts:32-35`). **Any discipline is capped at two scored streams.**
- **Determinism contract.** If you ever touch `roundFill`, call order of `makeRng` **is** the contract; inserting an RNG call changes every generated workout and requires bumping `GENERATOR_VERSION`. Another reason the MVP should not touch the generator.
- **Domain purity.** `src/domain/__tests__/domainPurity.test.ts` walks every file under `src/domain` and forbids React/RN/Expo/SQLite/BLE imports, `Math.random` and `Date.now()`. New vocabulary modules are covered automatically — put them under `src/domain/workout/`, not in `src/components/`.
- **No fast refresh on `F:`.** Metro's watcher is blind on that drive. Every edit batch needs a Metro restart plus an app cold restart; after a mass wav rewrite a stale Metro breaks clip loading outright. Iterate through `npx jest src/domain/...` before driving on glass.

---

## 8. Which disciplines are viable, concretely

Given H12 (hand + time + velocity only), D13 (transmit floor) and the two-MAC cap:

**Viable — scoreable as hand sequence:** boxing variants; hand-speed / reaction drills; numbered pad or target-tap patterns; percussion / drumline hand patterns (the instrument fork already proves the gesture half of this); dumbbell or weighted-glove punch-equivalent drills; any "call a code, athlete answers with the right hand, hard enough to transmit" game.

**Viable as DISPLAY-ONLY (scored 0, counted by time):** footwork, defense, breathing, stretching — exactly what `displayOnlyTokenIndexes` already models (`CueTimeline.ts:360`, `:369-373`). A discipline can be *mostly* display-only and still be a legitimate timed workout; it just cannot be graded.

**Not viable:** kicks/knees/elbows (no sensor on those limbs); anything soft or slow (below the transmit floor); anything requiring simultaneous bilateral grading (matcher limitation above); anything needing technique verification (H12 forecloses it permanently on this hardware).

---

## 9. Confusing, contradictory, or outright wrong things I found

1. **The task brief's example constant is wrong twice over.** `LEAD_IN_PAD_MS` is **250**, at `src/domain/coach/callPlacement.ts:38` — not 282, and not in `VoicePolicy.ts`. It *was* 282 in commit `ea5df336` and was reverted in `1af8a232` for cross-workout regressions.
2. **The brief's "H13" does not exist.** No `H13` anywhere in `docs/`, `src/` or `tools/`. The transmit floor is **D13**. Citing H13 in the handoff would send a new session hunting a hypothesis that was never written.
3. **TWO different interfaces named `ExpectedPunch`**, with different shapes: `CueTimeline.ts:71` (`{tokenIndex, hand, type?}` — the one that actually flows at runtime) and `StanceMapper.ts:27` (`{tokenIndex, number, hand, body}`). The StanceMapper one is **dead**: `resolveSequence` and `handSequence` (`StanceMapper.ts:100-131`) have zero production callers — only `resolveHand` and `isLeadNumber` are used. The `handSequence` doc comment claims it is "convenience for matching", which no longer describes anything.
4. **TWO different enums named `StrikeFamily`, with different values.** `src/domain/strikes/strikeCatalog.ts:56` → `'jab' | 'cross' | 'hook' | 'uppercut'`. `src/domain/instrument/strikeArticulationCatalog.ts:27` → `'straight' | 'hook' | 'uppercut'`. Also two `StrikeToken` (identical) and two `StrikeTarget` (identical). This is the already-materialized cost of the instrument fork, and it is exactly the drift the new abstraction exists to prevent.
5. **TWO different types named `VoicePolicy`:** `src/domain/timing/TimingEngine.ts:241` (the V1c string union, which is what `WorkoutBlock.voicePolicy` / `CueInstance.voicePolicy:157` actually carry) and `src/domain/coach/VoicePolicy.ts` (the V2 three-axis interface, reachable only through `compileCue`/`workoutScore`). `WorkoutTokens.ts:23` imports the **TimingEngine** one.
6. **`strikeCatalog.ts`'s own header describes a consolidation that never completed.** It says "when the render pipeline moves to V2 those constants should re-import from here so the two never drift again" (`:124-127`) — and `tools/voice/prosody.mjs:44` still carries an independent `TECHNIQUE_WORDS` copy. They currently agree; nothing enforces it.
7. **`src/domain/coach/vocabulary.ts` throws on a widened alphabet.** `comboPhraseAssets` raises `RangeError` for any punch number outside 1-6 (`:62-66`). It is called from `CueAnnouncer.ts:593/:611/:932/:1156` and `workoutScript.ts:391/:411`. It is also largely vestigial (the per-punch phrase bank it serves was retired in Phase 5-iv; `VoiceOutputExpo.playCombination()` is a hardwired `return false`), yet it is still on the live call path and will be the first hard crash of any alphabet widening.
8. **`goalAllocation.ts:48` has its own `COUNT_SCORED_KINDS`** — `{volume-burst, open-pressure, coast}` — which differs from `CueTimeline.ts:193`'s set (which also includes `active-recovery`). Two sets, one name, different members.
9. **D20 vs code.** `docs/design-spec.md` D20 says "Timing is no longer scored" and `timingWindowPct` is retired; `cueScoring.ts` still computes and aggregates it against `TIMING_TIGHT_MS = 150`.
10. **`'exact-combo'` is a `BlockKind` nothing ever emits**, and `'coast'` / `'sustained-strike'` exist only in types plus a retired fixture. A `'sustained-strike'` block is silently dropped into `deferredBlockIds` by `CueTimeline.ts` rather than rendered. Do not model a new discipline on them.
11. **`corpusMotifs.ts`'s header is stale on two counts** — it says corpus motifs are "NOT merged into MOTIFS yet" and that the generator "keeps selecting from the legacy 31" (`MOTIFS` has 32, and `roundFill` already selects `BUILD_UP_SETS` as the round spine).
12. **`clickScriptManifest.ts`'s header still says "Not yet wired to the runtime."** It is the live bank for all 22 shipped workouts.
13. **39 of 164 click-map rows have a spoken `leadIn` whose bar count disagrees with `reps`** (always the copy claiming ~2 more bars), and `clickMapsSelfCheck` does not validate bar counts. The wrong numbers are baked into the shipped wavs. **Relevant to the plan:** do not copy a boxing lead-in as a template for new copy, and consider adding a bar-count assertion to the self-check *for the new vocabulary only* so the new content starts clean.
14. **Clips are looked up by SLOT, never by text** (`lead-in/<workout>/rNsM`). Nothing in the suite asserts `row.leadIn === clip.text`. Editing a `leadIn` string keeps playing the old audio with no failure anywhere.
15. **`docs/audio-corpus.md` and `docs/audio-validation-rulebook.md` are stale on their central subject** (both treat the retired 776-clip phrase bank as primary). Rulebook steps 3 and 4 **cannot run** — `cadence_audit.py:93` and `build_phrase_timing.py:143` both read the deleted `src/audio/voiceAssets/phraseManifest.ts`. Trust `callPlacement.ts`'s own comments and the generated manifests.
16. **There is genuinely no discipline/activity-type/modality concept anywhere.** Grepping `src/ docs/ tools/` for `discipline|activityType|modality|sportType` returns only prose uses of the English word "discipline" (e.g. "identity discipline", "transaction discipline") and one lead-in script line. Step 1 of §5 is the first such concept in the codebase.


## Open questions

- Which concrete non-boxing discipline is the target? The Tier A vs Tier B decision in §3 turns entirely on whether it fits ≤6 alternating-hand roles × one binary variant. Without that, I can only hand over the decision rule, not the decision.
- Is the new discipline meant to be scored at all, or is a timed display-only workout acceptable? D13's transmit floor forecloses any soft/slow discipline from scoring, and H12 forecloses technique verification permanently — so some plausible disciplines can only ever be 'followed', not 'graded'. Which does Kyle want?
- Should a new discipline be a 4th tab (beside velocity-lab / punchcraft / puncheokie, `src/app/(tabs)/_layout.tsx:314-336`) or a selector inside punchcraft's existing sample grid? The latter is far cheaper (one entry in `samples/index.ts`), the former matches how puncheokie was shipped — but puncheokie forked the engine, which is the outcome this roadmap is trying to avoid.
- Does the new discipline need the techniques vocabulary, or is numbers-only acceptable for v1? This exactly doubles the render budget (≈16 clips → ≈32) and doubles the ASR-gate iteration cost, which is the slowest part of the loop.
- Is new avatar art in scope, or is the `guard.png` fallback acceptable for the MVP? 12 new source-art pairs are needed for `tools/avatar/make_punch_frames.py`, and that is art work, not code work.
- Should the simultaneous-two-handed limitation (§7) be fixed as part of this, or declared out of scope? It is structurally expressible today (`GeneratedWorkout.ts:69` allows equal offsets) but the matcher will mis-assign it — a latent bug that a new discipline is more likely than boxing to walk into.
- Nothing in `src/ble/` initiates or checks a bond, and the bonding requirement exists only in Kyle's memory file with no H-number. Should this roadmap include writing it into `docs/protocol/hypotheses.md` as H13 (the next free number), so a new session stops re-deriving a 37-second disconnect?
