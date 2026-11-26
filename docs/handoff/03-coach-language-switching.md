# Coach vocabulary: "numbers" vs "strike names" — types, storage, live switching, clip resolution, coverage

# Coach vocabulary: numbers vs strike names

Everything below was read out of the working tree at `F:/punchCraft` and, where it says *measured*, computed by running the code or parsing the shipped manifests on 2026-11-25. Last repo commit 2026-09-26.

## 0. TL;DR verdict

| Question | Answer |
|---|---|
| Is there a type for vocabulary? | **Five type names, three different string pairs.** See §1. |
| Where is the choice stored? | `WorkoutRecipe.voiceVocabulary` is the authority. A persisted settings-store copy exists and is **dead**. A fourth, screen-local `useState` is the live override. See §2. |
| Can it change mid-workout? | **Yes — implemented and shipping**, via an always-visible radio on the live screen (`testID="vocab-radio"`). It applies *within the current round*, rebuilding that round's call schedule. See §3. |
| Does it work on every path? | **No.** It works on the click-script path (= all 22 shipped workouts). It is a **no-op on the V2 score path** and on the round-1 pre-bell opener. See §3.4 / §3.5. |
| Both vocabularies fully rendered? | **Yes, exactly symmetric by count** (736 click-script clips = 368 + 368; 218 combo-announces = 109 + 109). But ~10 techniques lead-ins speak *numeric* cue words, and 3 techniques pump-bar calls still carry a known synthesis defect the numbers side was fixed for. See §5. |
| Duration difference? | **techniques ≈ 1.14–1.16× numbers overall**, max 2.25×, and 18/70 call slots are *shorter* in techniques. The doc's "roughly four times" is wrong. See §6. |
| Does the announcer downgrade names→numbers at high cadence? | **No. There is no downgrade anywhere in the code.** It is documented in four places and implemented in zero. See §6.3. |
| Fused "One-bee" body shots? | Implemented in two renderers, **enforced by no test or guard**; verified compliant in the shipped bank by audit. See §7. |

---

## 1. The types — five names, three string pairs

```
src/domain/coach/VoiceCoachPolicy.ts:70   export type VoiceVocabulary   = 'numbers' | 'names'
src/domain/workout/WorkoutRecipe.ts:48    export type VoiceVocabulary   = 'numbers' | 'names'   // DUPLICATE declaration
src/domain/coach/VoiceOutputPort.ts:196   export type CalloutVocabulary = 'numbers' | 'techniques'
src/domain/coach/callPlacement.ts:31      export type CallVocabulary    = 'numbers' | 'techniques'
src/audio/SlotDispatcher.ts:68            export type CoachVocabulary   = 'numeric' | 'technique'
```

Plus a sixth, inline-only spelling: `'numbers' | 'techniques'` written as a literal union (not via `CalloutVocabulary`) in `clickScriptManifest.ts:20`, `introPlan.ts:74`, `_useWorkoutRunner.ts:297` and `_useWorkoutRunner.ts:2251`.

**This is the single biggest trap in the subsystem.** Four translations happen at runtime, all hand-written ternaries:

| Site | Translation |
|---|---|
| `live.tsx:196` | `effectiveVocabulary === 'names' ? 'techniques' : 'numbers'` |
| `live.tsx:205` | same, but off `recipe.voiceVocabulary` (not the live override) |
| `live.tsx:300` | same, for the generator's `voiceReady` gate |
| `_useWorkoutRunner.ts:462, :676, :1703` | `voice?.policy.vocabulary === 'names' ? 'techniques' : 'numbers'` |
| `_useWorkoutRunner.ts:1783-1784` | `voice.policy.vocabulary === 'names' ? 'technique' : 'numeric'` |
| `src/audio/coachAssetResolvers.ts:63-67` | `vocabForCatalog(v) { return v === 'numeric' ? 'numbers' : 'techniques' }` |

`coachAssetResolvers.ts:13-19` is the only place that documents the convention explicitly:

> "The compiler uses `'numeric'` / `'technique'`; the audio catalogs use `'numbers'` / `'techniques'`. … the domain stays in `'numeric'` / `'technique'`."

That rule is **violated by `callPlacement.ts`**, which lives under `src/domain` and uses the *catalog* spelling (`CallVocabulary = 'numbers' | 'techniques'`). Deliberately — it is shared with the Node render tools — but it means "domain always says numeric" is false.

Note the V2 three-axis `src/domain/coach/VoicePolicy.ts` has **no vocabulary concept at all** (grepped: zero hits for `vocab|numeric|technique`).

**UI label vs value mismatch:** the live radio's values are `'numbers' | 'names'` but its *visible labels* read `Numbers` / **`Techniques`** (`live.tsx:1094`), while the Settings screen for the same pair reads `Numbers` / **`Names`** (`src/app/settings/voice.tsx:51-54`). Same choice, two different words on two screens.

---

## 2. Where the choice lives — four places, one authority

### 2.1 The authority: `WorkoutRecipe.voiceVocabulary`

```ts
// src/domain/workout/WorkoutRecipe.ts:107
voiceVocabulary: VoiceVocabulary
// src/domain/workout/WorkoutRecipe.ts:210  (defaultRecipe())
voiceVocabulary: 'numbers',
```

Set from the recipe screen: `src/app/(tabs)/punchcraft/recipe.tsx:111-114` (`VOICE_VOCABULARY_OPTIONS`) → `recipe.tsx:296` `onChange={(voiceVocabulary) => setRecipe({ voiceVocabulary })}`, `testID="voice-vocabulary"`.

Also settable by the QA deep link: `src/app/qa/run.tsx:107-109`
```ts
// The recipe is the single source of truth for the vocabulary — and the
// only thing that reaches the round-1 opener.
workoutStore.setRecipe({ voiceVocabulary: request.vocab === 'techniques' ? 'names' : 'numbers' })
```

### 2.2 The dead copy: `useVoiceSettingsStore.policy.vocabulary`

`src/app/settings/voice.tsx:132-135` renders a persisted radio writing `setPolicy({ vocabulary })`. **It has no effect on a workout.** `live.tsx:132-134` overwrites it:

```ts
// live.tsx:127-134
// The recipe is the single source of truth for HOW the coach speaks
// (voiceMode) and WHICH words it uses (voiceVocabulary) … its stale
// mode/vocabulary must never win: the lab caught the coach saying
// "jab, cross" against a recipe that plainly said Numbers, because the
// store defaulted to 'names'.
const policy = React.useMemo(
  () => ({ ...storePolicy, mode: recipe.voiceMode, vocabulary: recipe.voiceVocabulary }),
  [storePolicy, recipe.voiceMode, recipe.voiceVocabulary],
)
```

The two defaults still disagree: `defaultVoiceCoachPolicy()` returns `vocabulary: 'names'` (`VoiceCoachPolicy.ts:106`, with a doc comment arguing *"Names, not numbers … because it teaches while it calls"*), while `defaultRecipe()` returns `'numbers'`. The recipe wins, so a fresh install ships **Numbers** while the Settings screen shows **Names** selected. Nothing reconciles them.

### 2.3 Sample workouts do **not** pin vocabulary

All 22 shipped samples override `voiceMode: 'minimal'` (e.g. `src/domain/workout/samples/bodyWork.ts:74`) but **none sets `voiceVocabulary`** (grepped `src/domain/workout/samples/*.ts`: zero hits). They therefore inherit `defaultRecipe()`'s `'numbers'`, and that value is **ignored anyway** — `live.tsx` reads the *store* recipe, and `useWorkoutStore.selectSample` does not touch the recipe (`src/state/useWorkoutStore.ts:112-114`). So picking a library workout leaves the vocabulary wherever the recipe screen left it.

(Contrast with `voiceMode`, which *is* read from the sample in two places: `live.tsx:214-218` `preloadLight`, and `_useWorkoutRunner.ts:1688-1691` `effectivePolicy` / `:1759` `scoreDispatchEnabled`. Vocabulary has no such sample-side read.)

### 2.4 The live override: screen-local `useState`

```ts
// live.tsx:186-196
// Live vocabulary override (Kyle's mid-workout radio): dispatch-time
// only. Clips resolve at play time and preload keeps BOTH tracks warm,
// so the flip is instant — no engine rebuild, no rhythm-map change.
const [liveVocabulary, setLiveVocabulary] = useState<'numbers' | 'names' | null>(null)
const effectiveVocabulary = liveVocabulary ?? recipe.voiceVocabulary
const clickVocabulary = effectiveVocabulary === 'names' ? ('techniques' as const) : ('numbers' as const)
```

`setLiveVocabulary` is called from exactly one place: `live.tsx:1074`, the radio's `onPress`. It is **never reset** — not on workout start, not on workout end, not on phase change.

**Consequence worth flagging:** `live.tsx:167-180` documents that *"`(tabs)` keeps a once-visited screen MOUNTED"*. If that holds, `liveVocabulary` survives leaving and re-entering the live screen, so a flip during workout 1 silently carries into workout 2 while the recipe screen still shows the original choice — and because `startClickVocabulary` (§3.5) comes off the recipe, workout 2's round-1 pre-bell opener would speak the *recipe's* vocabulary while every in-round call speaks the flipped one. Not covered by any test; worth confirming on glass.

---

## 3. Live mid-workout switching — the exact mechanism

**It is implemented.** The UI is a two-option radio pinned to the live screen's top bar (`live.tsx:1065-1097`, `styles.vocabRadio` at `:1162-1177`: `position:'absolute', top:8, right:110`). It is rendered unconditionally — not gated on phase, `voiceMode`, or whether a click bank exists.

### 3.1 The wire (and a duplicate)

```ts
// live.tsx:398-408  — "THE missing wire (Kyle 2026-09-04: flipped the radio,
// 'still running on numeric a whole minute later'): the radio only ever set
// screen state — the runner was never told."
React.useEffect(() => {
  runner.setVocabulary(clickVocabulary)
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [clickVocabulary])
```

**There is a second, redundant copy of this effect** 250 lines later:

```ts
// live.tsx:662-664
React.useEffect(() => {
  runner.setVocabulary(clickVocabulary)
}, [runner, clickVocabulary])
```

`runner` is a fresh object every render, so this one fires on **every render**. It is harmless only because `setVocabulary` early-returns when unchanged (`_useWorkoutRunner.ts:2252`). One of the two is dead code; the first has an eslint-disable specifically to suppress the dep the second one includes.

### 3.2 What the runner does on a flip — `_useWorkoutRunner.ts:2251-2270`

```ts
setVocabulary: (vocabulary: 'numbers' | 'techniques') => {
  if (clickVocabularyRef.current === vocabulary) return
  announcerRef.current?.setVocabulary(vocabulary)
  clickVocabularyRef.current = vocabulary
  // MID-SET flip (Kyle 2026-09-04: "switched it to technique and it's
  // still running on numeric a whole minute later"): rebuild the
  // CURRENT round's schedule in the new vocabulary, then retire
  // everything already in the past so nothing back-fires — the next
  // due call speaks the new set.
  const snapshot = sessionRef.current?.snapshot()
  if (!snapshot || snapshot.phase !== 'work') return
  buildLeadInSchedule(snapshot.roundIndex)
  const schedule = leadInScheduleRef.current
  if (schedule) {
    for (const entry of schedule.entries) {
      if (entry.dispatchAtMs <= snapshot.workElapsedMs) entry.state = 'skipped'
    }
  }
}
```

Three effects, in order: the announcer's dialect flips; the ref flips; the **current round's whole lead-in/call schedule is recompiled** and everything already past is marked `'skipped'`.

**Note the guard:** `if (snapshot.phase !== 'work') return` — a flip during **rest** or **countdown** updates the ref and the announcer but performs **no rebuild**. That is fine because the next `work-entered` transition rebuilds the schedule anyway (`applyTransitions`), but it means a flip during rest does not retroactively change anything already queued for that rest (recovery script, warn playlist — see §3.5).

### 3.3 What is recomputed vs. frozen

`buildLeadInSchedule(roundIndex)` (`_useWorkoutRunner.ts:678-807`) reads `clickVocabularyRef.current` once at the top (`:679`) and recomputes **all** of:

| Recomputed on flip | Where |
|---|---|
| Every bar's call clip (`findClickScript('call/<motif>', vocabulary)`) | `:699` |
| Every call's `dispatchAtMs`, `firstNodeMs`, `breathMs` via `callDispatchAtMs({..., vocabulary})` | `:706` |
| Every section lead-in clip (`lead-in/<id>/rNsM`) | `:752` |
| Every lead-in's `dispatchAtMs` / `endByMs` via `leadInDispatchAtMs({..., vocabulary})` | `:762` |
| The build-time **collision filter** (a call whose window overlaps a lead-in's padded window is dropped) — durations differ per vocabulary, so a *different set of calls survives* | `:786-795` |
| `maskedCueIdsRef` — the **visual** mask of which bars show as "called" | `:798-805` |

So a flip changes the *visuals* too, not only the audio.

**Frozen / not recomputed:**

- `timelineRef` / `CueTimeline` — the ring grid never moves. Vocabulary cannot change strike timing.
- `rhythmMaps` (`_useWorkoutRunner.ts:461-499`, deps `[timeline, workout.recipe, voice]`). `voice` is memoized on `[output, policy, detector]` (`live.tsx:235-238`) and `policy` carries the **recipe's** vocabulary, so `voice` is referentially stable across a flip → the rhythm maps never recompile. Inert anyway: `combinationDurationMs` unconditionally returns `undefined`.
- The compiled `CompiledWorkoutScore` / `SlotDispatcher` — see §3.4.
- The round-1 pre-bell opener — see §3.5.
- `metronomeScheduleRef`, avatar track, walk plan.

### 3.4 The flip is a **no-op on the V2 score path** — and its own comment says otherwise

```ts
// _useWorkoutRunner.ts:1752-1757
// Vocab picking: the announcer holds the current callout vocab; the
// dispatcher asks fresh on every slot dispatch so a mid-workout
// toggle takes effect on the next unarmed slot …
slotDispatcher = new SlotDispatcher({
  getCurrentVocabulary: () =>
    voice.policy.vocabulary === 'names' ? 'technique' : 'numeric',   // :1783-1784
```

The closure *does* re-read on every dispatch — but it reads **`voice.policy.vocabulary`, which is the recipe's value and never changes during a workout.** `liveVocabulary` is not in that chain. So on the score path a live flip has **zero effect**, contradicting the comment directly above it.

(Moot in production today: `scoreDispatchEnabled = workout.recipe.voiceMode !== 'minimal'` at `_useWorkoutRunner.ts:1759`, and all 22 samples set `'minimal'`, so no `SlotDispatcher` is ever constructed on a shipped workout. It matters the moment a non-minimal workout ships.)

Also declared-but-dead on this path:
- `CompiledCoachSlot.vocabLockAtTick` (`workoutScore.ts:273`, computed at `:511` as `reservationStartTick - preloadMarginTicks`) is **read by nothing** outside tests. Principle #8's vocab lock is not enforced.
- `CompiledCoachVariant.transformReason` (`workoutScore.ts:237-241`), whose members include **`'converted-to-numeric'`**, is **never assigned anywhere in `src/`**. This is the only type-level trace of the documented downgrade. See §6.3.

`SlotDispatcher.pickVariant` (`SlotDispatcher.ts:269-279`) *does* fall back **bidirectionally** — preferred vocabulary, then the other, then `throw`. That is the opposite of `findClickScript`'s one-way fallback (§4.3).

### 3.5 What the flip reaches, and what it misses

| Surface | Follows the live flip? | Evidence |
|---|---|---|
| Per-bar calls (`call/<motif>`), current round | **Yes, immediately** | `_useWorkoutRunner.ts:2257` rebuild |
| Section lead-ins (sections 2+), current round | **Yes** | same rebuild, `:752` |
| Masked-bar visuals | **Yes** | `:798-805` |
| `CueAnnouncer` dialect | **Yes** | `:2253` → `CueAnnouncer.ts:303-305` |
| `VoiceOutputExpo` per-token manifest lane | **Yes** | `live.tsx:227` `output.setVocabulary(effectiveVocabulary)` — **but** inside an effect that early-returns `if (!holdAudio) return` (`live.tsx:224`) |
| Rounds 2+ pre-bell opener (warn playlist) | **Yes** | `live.tsx:485` uses `clickVocabulary`; dep list at `:492` |
| Recovery-script time budget | **Yes** | `live.tsx:528`, deps `:542` |
| **Round 1 pre-bell opener (walkout/intro)** | **No — deliberately** | `live.tsx:373` `planIntro(workout, undefined, startClickVocabulary)` |
| **V2 `SlotDispatcher` / combo-announces** | **No — unintentionally** | §3.4 |
| `generateWorkout`'s `voiceReady` content gate | **No** | `live.tsx:300` reads `recipe.voiceVocabulary` |
| `rhythmMaps` | **No** | §3.3 |

The round-1 exclusion is documented and intentional (`live.tsx:197-205`):

> "It MUST come from the recipe, not the live radio: the intro drives `countdownMs`, which is a dependency of the engine-build effect, so if it changed on a live flip the whole engine would rebuild and reset the workout to 'Hit It' (regression, Kyle 2026-09-04)."

### 3.6 Already-queued and already-sounding audio

- **A sounding clip is never cut.** `setVocabulary` calls no `cancel`. A lead-in or call already playing in the old vocabulary plays to its end.
- **The old schedule is discarded wholesale.** `leadInScheduleRef.current` is replaced by the rebuild, so a due-but-unplayed old-vocabulary entry vanishes.
- **Nothing in the past re-fires:** every rebuilt entry with `dispatchAtMs <= workElapsedMs` is forced to `'skipped'`.
- **Overlap is prevented by the busy lane, not by the flip.** The dispatch loop (`_useWorkoutRunner.ts:2047-2125`) checks `voice.output.audibleUntilMs()` and retries until `giveUpAtMs`; the one exception is `entry.firstRep`, which dispatches on schedule regardless (`:2068-2075`). So a flip whose new clip comes due while the old one is still talking will wait — unless it is a section's rep-0 call.
- **`VoiceOutputExpo.playSequence` APPENDS, never clears** (`VoiceOutputExpo.ts:1699`), so the per-token lane cannot be truncated by a flip either.
- **Two deferral mechanisms exist and one is dead.** `VoiceOutputExpo.setVocabulary` (`:919-925`) defers into `pendingVocabulary` when an event is armed (`ArmedCoachEvent.lockedVocabulary`, `:187`), committing at the next `armCoachEvent` (`:885`). `armCoachEvent` is called from exactly one place — `CueAnnouncer.ts:352` — which is dormain under `effectivePolicy.mode === 'minimal'` (§4.5). `CueAnnouncer.setVocabulary` (`:303-305`) has **no** deferral and applies immediately.

### 3.7 Preload: the "both tracks stay warm" claim is false on shipped workouts

`live.tsx:188` claims *"preload keeps BOTH tracks warm, so the flip is instant."* The both-vocabulary warm is at `VoiceOutputExpo.ts:1038-1045`:

```ts
if (!opts?.light) {
  const primary = this.vocabulary
  this.vocabulary = primary === 'numbers' ? 'names' : 'numbers'
  for (const [id, form] of warm) this.playerFor(id, form)
  this.vocabulary = primary
}
```

`preloadLight` is `true` whenever the chosen workout's `voiceMode === 'minimal'` (`live.tsx:214-218`) — i.e. on **all 22 shipped workouts** — so the branch is skipped. And it would not help anyway: the click-script bank uses a *separate* player cache keyed by `clip.module` (`VoiceOutputExpo.ts:1288`, `CLICK_SCRIPT_RESIDENT_CAP = 8`), which has no pre-warm for the other vocabulary. **On a real flip the first clip in the new vocabulary pays a cold native-player load** (the code elsewhere measures that at ~100–200 ms, `VoiceOutputExpo.ts:1269-1273`). There is no evidence anyone has measured whether that pushes the first flipped call late.

### 3.8 Test coverage of the flip: none end-to-end

`setVocabulary` appears in tests only as unit calls on `VoiceOutputExpo` (`src/audio/__tests__/VoiceOutputExpo.test.ts:776, :811, :827, :846, :1052`) and `CueAnnouncer` (`src/domain/coach/__tests__/CueAnnouncer.test.ts:713`). **Nothing tests `live.tsx`'s radio, `runner.setVocabulary`, the mid-round rebuild, or the skip-the-past pass.** The `vocab-radio` / `vocab-numbers` / `vocab-names` testIDs are unreferenced by any test.

---

## 4. Vocabulary → clip on disk

### 4.1 Click-script bank — the live path

**Directory:** `assets/voice/click-scripts/cornerman3/` — one flat directory, both vocabularies, **738 wavs on disk, 736 in the manifest** (orphans: `cc-3ef58955.wav`, `cc-45bae125.wav`; the latter is `sha1('One, one. One, one!')`, the retired pair-grouping take of `call/1-1-1-1`). Sibling `assets/voice/click-scripts/cornerman2/` holds 255 fully orphaned wavs from the retired persona.

**Filename = clip id + `.wav`. The id encodes the vocabulary in its 2-letter prefix** (`tools/voice/make-click-script-clips.mjs:102-130`, `assemble()`):

```
<prefix>-<sha1(text).slice(0,8)>

numbers:     li = lead-in   rr = rest   cc = call
techniques:  lt = lead-in   rt = rest   ct = call
```

**Slot key grammar** (the lookup key — *not* the filename):
```
call/<motif>                     motif = bar tokens joined by '-', '.' for a rest   e.g. call/1-2b-3-2, call/1-.-2-.
lead-in/<workoutId>/r<N>s<M>     1-based round, 1-based section ORDER in the round  e.g. lead-in/body-work/r3s1
rest/<workoutId>/r<N>
```

Clips are **deduped by exact text**, so one wav can cover several slots and `clip.slots` lists them all. Measured distinct counts:

| | clips | distinct slots |
|---|---|---|
| numbers/lead-in | 258 | 262 |
| numbers/rest | 41 | 41 |
| numbers/call | 69 | 70 |
| techniques/lead-in | 258 | 262 |
| techniques/rest | 41 | 41 |
| techniques/call | 69 | 70 |

**Lookup — `src/audio/voiceAssets/clickScriptManifest.ts`, tail:**

```ts
export function findClickScript(
  slot: string,
  vocabulary: 'numbers' | 'techniques' = 'numbers',
): ClickScriptClip | undefined {
  return (
    CLICK_SCRIPT_CLIPS.find((c) => c.vocabulary === vocabulary && c.slots.includes(slot)) ??
    (vocabulary === 'techniques'
      ? CLICK_SCRIPT_CLIPS.find((c) => c.vocabulary === 'numbers' && c.slots.includes(slot))
      : undefined)
  )
}
```

**Fallback is ONE-WAY: techniques → numbers.** Doc comment: *"a partially rendered techniques bank degrades to the numeric copy rather than to silence."* There is **no** numbers → techniques fallback — a missing numbers clip is silence.

The manifest header still carries a false line: *"Not yet wired to the runtime — click sets run coach-minimal today."* It is the live bank.

### 4.2 Combo-announce bank — V2 score path (dormant in production)

**Directory:** `assets/voice/combo-announces/cornerman/` — the **old `cornerman` persona, 24 kHz** (verified by wav header), while the click bank is cornerman3 at 48 kHz. 218 wavs.

**Filename/id scheme puts the vocabulary last:** `ca-<combination>-<vocabulary>.wav`, e.g. `ca-slip-1-2-numbers.wav`, `ca-slip-1-2-techniques.wav`.

**Lookup — exact match, NO fallback:**
```ts
export function findComboAnnounce(combination: string, vocabulary: CalloutVocabulary) {
  return COMBO_ANNOUNCE_CLIPS.find(
    (c) => c.combination === combination && c.vocabulary === vocabulary)
}
```
Doc comment: *"A missing clip means the announce-then-work block falls back to silence for that combo — the runtime does not synthesize at runtime."*

This manifest is also the generator's **content gate**: `live.tsx:305` `voiceReady: (notation) => findComboAnnounce(notation, vocabulary) !== undefined`. Because that `vocabulary` comes from the *recipe*, choosing Names can in principle change which ladders the generator will even select — though measured coverage is 109/109 in both, so it rejects nothing today.

### 4.3 Per-token manifest — `numbers/{standalone,combo}` vs `names/{standalone,combo}`

`src/audio/voiceAssets/manifest.ts` is the only place where directory layout is literally `vocabulary/form/id.wav`:

```ts
// manifest.ts:62
assets: Record<VoiceVocabulary, Record<PhraseForm, SlotAssetMap>>
// PhraseForm = 'standalone' | 'combo'   (manifest.ts:42)
```

Resolution is `this.vocabulary` on the output object, not a parameter:
```ts
// VoiceOutputExpo.ts:1125
const module = this.manifest.assets[this.vocabulary][form][id]
// VoiceOutputExpo.ts:1939  (LRU cache key)
return `${this.vocabulary}/${form}/${id}`
```

On-disk counts: `numbers/standalone` 363, `numbers/combo` 101, `names/standalone` 101, `names/combo` 101. (`numbers/standalone` is inflated by the single-directory rule — it also holds the `co-*`, `su-*`, `ts-*`, `intro-*`, `warn-*`, `rec-*` families.)

**Asymmetry:** the fused body ids `1b`–`6b` ship **only** in `numbers/standalone`. Verified on disk: `assets/voice/names/standalone/` contains `1.wav`…`6.wav` and no `Nb.wav`. This is encoded in the type system (`manifest.ts:48-57`, `CoreAssetId` / `FusedBodyId`, `VoiceOutputPort.ts:220-236` `FUSED_BODY_ASSET_IDS`) and in `missingAssetIds`'s `fusedBodyExempt` rule (`manifest.ts:265`). Reaching one under `names/*` throws (`VoiceOutputExpo.ts:1133`), caught and logged as `puncheokie.voice.clipMissing`.

This lane is near-dormain: `comboPhraseAssets` (`src/domain/coach/vocabulary.ts:54-85`) is vocabulary-**agnostic** (returns `['1','2b','3']`), and the only caller is `CueAnnouncer.dispatchPerWordCall` (`:592-602`), which §4.5 shows is gated off on every shipped workout. `playAsset`/`emit` for bells, ceremony `co-*` and instructions still goes through `playerFor`, so **the bell's clip path technically changes vocabulary with the flip** — harmless because `bell.wav` exists in all four slots.

### 4.4 Text generation — where the two vocabularies' words come from

Single source: **`tools/analysis/gen-workout-scripts.ts`** (479 lines), executed live at render time by `tools/voice/make-click-script-clips.mjs:94-101` via `--corpus`.

- Numbers tokens: `WORDS` at `gen-workout-scripts.ts:95-98` — `'1':'one' … '6':'six'`, `'1b':'one-bee' … '6b':'six-bee'`.
- Techniques tokens: `tools/voice/prosody.mjs:44-51` `TECHNIQUE_WORDS` — `1 Jab / 2 Cross / 3 {full:'Lead hook', compact:'Hook'} / 4 Rear hook / 5 {full:'Lead uppercut', compact:'Lead upper'} / 6 {full:'Rear uppercut', compact:'Rear upper'}`. `COMPACT_CADENCES = new Set(['pressure','sprint'])` (`prosody.mjs:69`). Lead-ins/rests use **full** forms, per-bar calls use **compact** (`gen-workout-scripts.ts:100-104, :126-127`).
- Lead-in and rest prose is authored **numeric only** and machine-translated by `techniqueText(text, notes)` (`gen-workout-scripts.ts:132-209`) under five rules: `head X`→`head <tech>`; `body X-bee`→`body <tech>`; plural `X-bees`/`Xs`; comma-runs of 2+ cue words member-wise; residual `X-bee`; `the X` prose refs. Anything left over is reported, not guessed: `notes.push('RESIDUAL numeric "<word>" — review')`.
- Per-bar call text: `callText(motif)` (numbers, `:324-333`) and `callTextTechnique(motif)` (`:235-244`), with two override tables:
  - `CALL_NUMBER_OVERRIDES` (`gen-workout-scripts.ts:313-321`): `'1-1-1-1': 'One! One! One! One!'`, `'1-2b-1-2b': 'One, two-bee. One, two-bee!'`
  - `CALL_TECHNIQUE_OVERRIDES` (`gen-workout-scripts.ts:226-233`), six entries existing purely to fit the stride: `'1b-1b-1b-1b':'Body jabs!'`, `'1b-2-1-2':'Body jab, cross-jab-cross!'`, `'1-2-5-2':'Jab-cross-lead-upper-cross!'`, `'1-2b-3b-2':'Jab, body cross-hook, cross!'`, `'1b-2b-3b-2b':'Body jab-cross, body hook-cross!'`, `'1-2b-5b-2':'Jab, body cross-lead-upper, cross!'`
  - and a third, render-time table `CALL_CLIP_OVERRIDES` (`make-click-script-clips.mjs:181-194`) keyed `'<vocabulary>|<slot>'`, five live entries — see §8.2.

### 4.5 Why click-script calls are audible at all under `mode:'minimal'`

The runner caps the **announcer's** policy:
```ts
// _useWorkoutRunner.ts:1688-1691
const effectivePolicy =
  voice && workout.recipe.voiceMode === 'minimal'
    ? { ...voice.policy, mode: 'minimal' as const }
    : voice?.policy
```
`shouldSpeak(policy,'punch-command',_)` with `mode:'minimal'` returns false (`VoiceCoachPolicy.ts:151-157` `MINIMAL_CATEGORIES = {stance-change, bell, final-countdown, metric}`), so `CueAnnouncer`'s call/refire/per-word branches are all dead on shipped workouts — which is why the per-token `numbers/names` manifest lane is effectively inert.

The **click-script dispatch loop takes the uncapped `voice.policy` and checks only `voiceAllowed`** (`_useWorkoutRunner.ts:2065`):
```ts
if (!voiceAllowed(voice.policy, playbackActiveRef.current)) continue
```
`shouldSpeak` is never consulted there. That bypass is the sole reason per-bar calls sound under `minimal`, and it is what makes the vocabulary choice audible at all today.

---

## 5. Coverage: is every phrase rendered in both vocabularies?

### 5.1 By count — exactly symmetric, and gated by two green tests

Measured from the shipped manifests: **373 distinct click-script slots, identical set in both vocabularies — 0 slots only-in-numbers, 0 only-in-techniques.** Combo-announce: **109 distinct combinations, both vocabularies present for all 109, 0 missing either side.**

Two Jest gates enforce it, both **green as of 2026-11-25**:

- `src/domain/workout/samples/__tests__/clickCallFit.test.ts` — `describe.each(['numbers','techniques'])`: every map motif has a rendered call clip in that vocabulary, **and** `clip.durationMs <= strideMs - 100` for the tightest occurrence; plus every round-opener `setupMeasures` pad fits `call + MIN_BREATH_MS`. `PENDING_OVER_STRIDE_TECHNIQUES` is `new Set<string>([])` and a fourth test asserts the list only shrinks. **8/8 pass.**
- `src/domain/workout/samples/__tests__/clickScriptCoverage.test.ts` — every `lead-in/<id>/rNsM` and `rest/<id>/rN` slot resolves in both vocabularies. **2/2 pass.**

Both are **per-workout/per-vocabulary gated**: a vocabulary with *zero* rendered slots for a workout is treated as "not rendered yet" and skipped. So they fail on a *partial* render, not on an absent one.

Full voice-adjacent suite run today: `src/domain/coach`, `VoiceOutputExpo`, `SlotDispatcher`, `(tabs)/punchcraft/__tests__`, `settings/voice`, `app/qa` → **12 suites, 315 tests, all passing.**

### 5.2 By content — the techniques bank is **not** semantically complete

Running the generator (`node --import ./tools/analysis/wav-stub.mjs --import tsx tools/analysis/gen-workout-scripts.ts --corpus`) emits `techniqueReview` with **36 of 303 techniques slots carrying `RESIDUAL numeric "…" — review` notes.** Most are benign English ("Every one comes home", "Three fast power shots", "Reset on four"). But these are genuine **mixed-vocabulary cue leaks that are already rendered into shipped wavs**:

| Slot | Shipped techniques text | Numbers source |
|---|---|---|
| `lead-in/switch-by-round/r2s3` (`lt-aa325078`) | "Body jab, jab, cross — straight time, nine bars. **Body one, head jab, two.** Reset your base on four." | "…**Body one, head one, two.**…" |
| `lead-in/speed-combos/r2s3` (`lt-ea87c873`) | "Body jab, jab, cross — time-and-a-half, eighteen bars. **Body one, head jab, two.** Fast level change, clean exit." | same shape |
| `lead-in/pump-and-coast/r1s2`, `r2s2`, `r4s2` | "Coast bar — **one, empty, empty, empty**, straight time, N bars. **One** touch, three empty slots…" | unchanged |
| `lead-in/pump-and-coast/r1s4`, `r3s2` | "Coast bar — **one, empty, two, empty** … **One, empty, two, empty.**" | unchanged |
| `lead-in/pace-pusher/r1s2` | "Coast bar — jab, cross, empty, empty … Same **one-two**, quicker slots…" | partially translated |
| `lead-in/switch-by-round/r1s4` | "**One** upstairs, body cross downstairs, **three** back upstairs." | partially translated |
| `lead-in/uppercut-clinic/r3s4` | "Keep the rear uppercut and **five** underneath the shoulders." | partially translated |
| `lead-in/progressive-buildup/r4s1`, `lead-in/pace-pusher/r4s1` | "changes the finish to **five**" / "changes only the middle to **five**" | partially translated |

**Root cause:** `techniqueText` rule 3 only translates *comma-adjacent runs* of cue words. `"Body one, head one, two"` → rule 1 converts `head one`→`head jab`, which **breaks the comma run**, orphaning `Body one` and `two`. The coast-bar copy (`"one, empty, two, empty"`) never translates because `empty` interrupts every run. The tool **reported** all of this and nobody acted; the wavs rendered and shipped. Nothing in the test suite checks a techniques clip's text for residual numerals.

### 5.3 The 4-of-same synthesis defect is fixed in numbers and **not** in techniques

`CALL_CLIP_OVERRIDES` (`make-click-script-clips.mjs:181-194`) renames pump bars because *"Chatterbox collapses four identical words."* Five entries exist; four are `numbers|…`:

| Slot | numbers shipped | techniques shipped |
|---|---|---|
| `call/1-1-1-1` | `cc-41b6f3bf` "**Four ones!**" 889 ms | `ct-d7c94e92` "**Four jabs!**" 767 ms |
| `call/1b-1b-1b-1b` | `cc-e17a56ba` "**Four body ones!**" 1034 ms | `ct-17c7a3c5` "**Body jabs!**" 1050 ms |
| `call/2-2-2-2` | `cc-9189c64b` "**Four twos!**" 907 ms | `ct-708bc26a` "Cross, cross, cross, cross!" **1300 ms — unfixed** |
| `call/5-5-5-5` | `cc-5a20138e` "**Four fives!**" 897 ms | `ct-45bc130f` "Lead upper, lead upper, lead upper, lead upper!" **2015 ms — unfixed** |
| `call/3-3-3-3` | `cc-5a5a479b` "Three, three, three, three!" **1300 ms — unfixed** | `ct-087c3c86` "Hook, hook, hook, hook!" **1156 ms — unfixed** |

**Flipping to techniques re-exposes the elision defect on `2-2-2-2` and `5-5-5-5`.** The gate cannot catch it: `asrExact: true` passes because Whisper hallucinates the missing syllable back.

### 5.4 Confirmed: the id↔text invariant is broken on all five overridden slots

Clip ids are `sha1` of the **pre-override** corpus text, so an override's text and its id disagree. Verified:

```
cc-41b6f3bf = sha1('One! One! One! One!')                     but manifest text = "Four ones!"       (sha1 b2fd3d39)
cc-9189c64b = sha1('Two, two, two, two!')                     but text = "Four twos!"                (sha1 d8d9c4d9)
cc-5a20138e = sha1('Five, five, five, five!')                 but text = "Four fives!"               (sha1 4663902b)
cc-e17a56ba = sha1('One-bee, one-bee, one-bee, one-bee!')     but text = "Four body ones!"           (sha1 f835fba3)
ct-d7c94e92 = sha1('Jab, jab, jab, jab!')                     but text = "Four jabs!"                (sha1 33447c87)
```

Consequence: `--missing-only` sees the wav as present and never re-renders it. Re-render these with `--only-keys=cc-41b6f3bf,cc-9189c64b,cc-5a20138e,cc-e17a56ba,ct-d7c94e92`.

---

## 6. Duration difference and the cue window

### 6.1 Measured, from the shipped manifests

| Bank / kind | numbers | techniques | ratio |
|---|---|---|---|
| click **call** (69 clips ea.) | mean 1731 / median 1550 / 720–3262 ms | mean 2008 / median 1847 / 760–4207 ms | **1.160** aggregate |
| click **lead-in** (258 ea.) | mean 8590 / median 8471 / 5720–15356 ms | mean 9181 / median 8707 / 6320–19225 ms | 1.069 |
| click **rest** (41 ea.) | mean 14086 / 11000–16560 ms | mean 14734 / 11811–17679 ms | 1.046 |
| **combo-announce** (109 ea.) | mean 2659 / median 2773 / 1253–4133 ms | mean 3034 / median 3133 / 1333–5693 ms | **1.141** aggregate |

Per-slot spread is wide and **not monotone**. Of 70 call slots: **51 longer in techniques, 18 shorter, 1 equal.** Extremes:

```
call/5-5-5-5              897 → 2015   x2.25   (the unfixed pump bar, §5.3)
call/5-6-5-.             1200 → 2440   x2.03
call/6-3-6-3             1300 → 2300   x1.77
call/1-2b-3-2-1b-4b-3-.  2800 → 4207   x1.50  (+1407 ms, largest absolute)
...
call/1-1-2-1-2-3-2-.     3200 → 2396   x0.75   (techniques 804 ms SHORTER)
```

The shortening comes from `CALL_TECHNIQUE_OVERRIDES` — compressed shorthand ("Body jab-cross, body hook-cross!") is genuinely shorter than eight spoken digits.

### 6.2 How it interacts with the cue window

Three independent constraints, all vocabulary-aware:

**(a) The stride law** (`clickCallFit.test.ts`): `clip.durationMs <= strideMs - 100`, where `strideMs = measuresPerRep(slots, rate) * 4 * (60000 / map.bpm)`. Measured margins — **10 of 70 slots have under 300 ms of techniques headroom vs only 2 in numbers**. The tightest:

```
motif          stride   numbers (margin)   techniques (margin)
1b-2b-3b-2b     2400    2184 (116)         2250 ( 50)
1-2b-5b-2       2400    1800 (500)         2250 ( 50)
1b-2b-3b-.      2400    1800 (500)         2250 ( 50)
1-2-3-2         2000    1600 (300)         1846 ( 54)
1-4-3-2         2000    1354 (546)         1846 ( 54)
1b-2-1-2        2000    1550 (350)         1800 (100)
1-2-5-2         2000    1508 (392)         1800 (100)
```
No motif in the shipped maps runs a stride ≤ 1000 ms, so the "only numbers fits at high cadence" worry does not materialise today — **but techniques is routinely inside 100 ms of the limit**, and the limit is only held by the render tool's per-clip rubberband (`CALL_MAX_STRETCH`, capped at `max(1.3, …)` with 1.4–1.6 entries for exactly these motifs).

**(b) The call breath.** `breathForBar(cue, vocabulary, slot)` (`callPlacement.ts:250-276`) takes the vocabulary and uses it only for the **upper** bound:
```
DENSE_BREATH_MS = { numbers: CALL_PAD_MS + NUMBERS_CALL_LEAD_MS   = 500+100 = 600,
                    techniques: CALL_PAD_MS + TECHNIQUE_CALL_LEAD_MS = 500+250 = 750 }
breathMs = max(MIN_BREATH_MS + DELIVERED_BREATH_SHORTFALL_MS,            // 150+95 = 245
               min(dense, dense - BREATH_TRACK_GAIN * max(0, slotMs - BREATH_REF_SLOT_MS)))
dispatchAtMs = max(0, firstNodeMs - clipDurationMs - breathMs - CALL_DISPATCH_LAG_MS)  // lag = 71
```
Because vocabulary only moves the ceiling, **on wide/slow bars both vocabularies collapse to the same 245 ms floor** — the vocabulary stops mattering exactly where the bar is sparse. `CALL_BREATH_OVERRIDES = { 'call/1-.-.-.': 340, 'call/1-.-2-.': 340 }` (`callPlacement.ts:232-235`) is vocabulary-**blind** and wins outright over the formula.

**(c) The lead-in pad.** `leadInDispatchAtMs` (`callPlacement.ts:313-327`): `leadMs = vocabulary === 'techniques' ? TECHNIQUE_LEADIN_LEAD_MS (500) : 0`; `dispatchAtMs = max(0, endByMs - clipDurationMs - LEAD_IN_PAD_MS (250) - leadMs)`. Techniques lead-ins therefore start 500 ms earlier *plus* their own extra length.

**Round-opener pads are the binding constraint on a flip.** The bell releases into an authored `setupMeasures` pad that must fit `rep-0 call + MIN_BREATH_MS`. Measured techniques slack (`padMs − techClip − 150`), tightest first:
```
body-work r3                  pad 4800  num 2800  tech 4207  slack  443
three-round-fundamentals r2   pad 4000  num 2894  tech 3344  slack  506
pace-pusher r4                pad 4000  num 2300  tech 3137  slack  713
heavy-hands r2                pad 4000  num 2862  tech 2976  slack  874
```
Comfortable, but `body-work r3` has only 443 ms of room — and that pad is authored in `clickMaps.ts`, so any techniques re-render that grows `call/1-2b-3-2-1b-4b-3-.` past ~4650 ms breaks the gate.

### 6.3 **The "announcer downgrades to numbers" claim is documentation only**

Four places assert it:
- `src/domain/coach/VoiceCoachPolicy.ts:64-68` — *"`names` … costs roughly four times the phrase duration, which is why the announcer may downgrade to `numbers` at a cadence that cannot fit names."*
- `src/domain/workout/WorkoutRecipe.ts:42-46` — *"at high cadence `numbers` is the only vocabulary that fits, and the announcer downgrades to it."*
- `docs/workouts-ux-engine.md:1098-1099` — *"`CueAnnouncer` knows each phrase's duration and skips or downgrades rather than overlapping. `numbers` is the automatic fallback when the cadence cannot fit `names`, and the downgrade is surfaced rather than silent."*
- `docs/workouts-ux-engine.md:1108` — D15 rationale.

**Grepped the entire repo for `downgrade` (case-insensitive) across `src`, `docs`, `tools`, `.claude`: every hit in `src/` is about the QA-flag autostart downgrade or settings copy. There is no vocabulary downgrade code.** The only type-level trace is `CompiledCoachVariant.transformReason?: … | 'converted-to-numeric'` (`workoutScore.ts:240`), which is **never assigned**.

What exists instead, and it is the opposite shape:
- **Render-time fitting**, not runtime downgrade: `CALL_TECHNIQUE_OVERRIDES` rewrites copy and `CALL_MAX_STRETCH` rubberbands audio so the techniques clip *fits*, and `clickCallFit` proves it at build time.
- **One-way asset fallback** in `findClickScript` (techniques→numbers), which fires on a *missing clip*, never on a tempo problem.
- **Bidirectional asset fallback** in `SlotDispatcher.pickVariant`.

And the "four times" figure is wrong by a large factor: **measured 1.14× (combo-announce) and 1.16× (click calls)**, worst single slot 2.25×, with 18 of 70 call slots *shorter* in techniques.

---

## 7. Body shots: the fused "One-bee" rule

### 7.1 Numbers vocabulary — fused, hyphenated, one breath

`tools/voice/prosody.mjs:99-107`:
```js
const word = NUMBER_WORDS[digit]
// Punch-number body-shot delivery (Kyle A/B/C, 2026-08-28): "One-bee".
// The hyphen gets the emphasis right AND lands the "bee" at the right
// time … Other patterns tried and rejected:
//   "One bee"   (space)     — full pause, boxer commits head shot in gap
//   "Onebee"    (fused)     — eighth-note apart, blends to one blur
//   "One, bee"  (comma)     — half-note apart, but emphasis softer
//   "One... bee" (ellipsis) — whole-note apart, too spaced
// "bee" not "B" survives interior-lowercasing as /biː/ rather than /bʌ/.
return body ? `${word}-bee` : word
```
Restated independently in `gen-workout-scripts.ts:97`: `'1b':'one-bee' … '6b':'six-bee'`.

**Note the memory index's "Onebee/Twobee" phrasing is the *rejected* spelling.** The shipped form is the hyphenated `One-bee`, and the code comment explicitly rejects both `Onebee` (blurs) and `One bee` (gap).

Two more pieces of the mechanism:
- Asset-id level: `comboPhraseAssets` maps `2b` → the single id `'2b'`, never `['2','body']` (`src/domain/coach/vocabulary.ts:34-46`): *"Splitting the shot into `['2','body']` violated the A/B/C rule: the boxer committed the head-shot before 'body' arrived to redirect."* Clip at `assets/voice/numbers/standalone/2b.wav`.
- Render budget: `syllableUnits` in `make-click-script-clips.mjs:218-226` shields the fused token from the hyphen split (`text.replace(/-bee/g,'bee')`) and counts any `bee` word as **2** units.
- ASR gate: `tools/voice/asr_match.py:26-32` canonicalises Whisper's `b` / `be` / `bea` → `bee`, and `_FUSED_B = re.compile(r'^([1-6])b$')` expands a heard `2B` back to `['two','bee']`.

### 7.2 Techniques vocabulary — target front-loaded, **no "bee" at all**

`prosody.mjs:90-95`:
```js
if (vocabulary === 'techniques') {
  const entry = TECHNIQUE_WORDS[digit]
  const word = COMPACT_CADENCES.has(cadence) ? entry.compact : entry.full
  // The technique vocabulary names the target: "Body cross".
  return body ? `Body ${word.toLowerCase()}` : word
}
```
So `2b` is `"Body cross"`, `5b` is `"Body lead uppercut"` (full) / `"Body lead upper"` (compact). Audited the shipped techniques bank: the only `body <x>` forms present are `body cross | body cross-hook | body cross-lead-upper | body hook | body hook-cross | body jab | body jab-cross | body jabs | body lead … | body rear … | body uppercut` plus prose (`body shots`, `body work`, `body to`, `body into`, `body lines`) — **zero occurrences of "bee" in any techniques clip.**

### 7.3 Enforcement: **none**

- No test asserts the hyphenated form. `src/domain/coach/__tests__/vocabulary.test.ts:22` only asserts the *asset-id* is not split (`['2b']`, not `['2','body']`).
- No guard script checks it (`tools/guards/` contains only `velocity-terminology.mjs` and `playlist-sample-rate.mjs`).
- The rule is asserted only in a doc comment and in `docs/audio-corpus.md:159-166`.

**I audited the shipped manifest programmatically and it is compliant:** all six forms present (`one-bee`…`six-bee`), **0 violations** — no `One bee` (space), no `Onebee` (no hyphen), no `One, bee`, and no `bee` leaking into a techniques clip. So the invariant holds today by discipline, not by a gate. A single hand-edit to `prosody.mjs` or an authored string would ship silently.

**Also inconsistent:** `prosody.mjs:78-82`, the doc comment immediately above `spokenFor`, says *"A body shot reaches the synthesizer as words a person would say — 'Body two', never 'two bee'."* That describes the **techniques** branch while sitting on top of a function whose numbers branch returns exactly `two-bee`. It reads as a prohibition on the thing the code does.

---

## 8. Contradictions, stale comments and defects — ranked

1. **`SlotDispatcher.getCurrentVocabulary` cannot see the live flip** (`_useWorkoutRunner.ts:1783-1784`), while the comment four lines up (`:1752-1757`) claims it takes effect on the next unarmed slot. Dormant today (`scoreDispatchEnabled` false on all 22 samples) but a live bug the moment a non-minimal workout ships.
2. **Two techniques lead-ins ship half-numeric copy** — `lead-in/switch-by-round/r2s3` (`lt-aa325078`) and `lead-in/speed-combos/r2s3` (`lt-ea87c873`) both say *"Body one, head jab, two."* Plus ~8 more partial leaks (§5.2). Reproducible from source — the generator reports them as `RESIDUAL numeric` and nothing blocks the render.
3. **`call/2-2-2-2` and `call/5-5-5-5` are unfixed in techniques** for the 4-of-same elision the numbers side was renamed to dodge; `call/3-3-3-3` is unfixed in both (§5.3).
4. **"Announcer downgrades names→numbers at high cadence" is documented in 4 places and implemented in 0** (§6.3). `'converted-to-numeric'` and `vocabLockAtTick` are declared and never used.
5. **"roughly four times the phrase duration"** (`VoiceCoachPolicy.ts:68`) is measured at **1.14–1.16×**.
6. **Settings → Voice → Vocabulary is a dead control.** It persists, it is overwritten by `live.tsx:133`, and its default (`'names'`) disagrees with the recipe default (`'numbers'`), so the screen shows the wrong selection on a fresh install.
7. **`clickVocabularyRef`'s doc comment is contradicted by `setVocabulary`.** `_useWorkoutRunner.ts:670-674` says *"a mid-round radio flip applies from the following round"*; `:2255-2270` rebuilds the current round. Same for `live.tsx:189-191` *"Placement margins stay compiled with the starting vocabulary"* — `buildLeadInSchedule` re-runs `callDispatchAtMs`/`leadInDispatchAtMs` with the **new** vocabulary.
8. **Duplicate `runner.setVocabulary` effect** — `live.tsx:404-408` and `live.tsx:662-664`. The second fires every render.
9. **"Preload keeps BOTH tracks warm" is false on every shipped workout** (`preloadLight` is always true), and the click-script cache has no cross-vocabulary pre-warm at all (§3.7).
10. **Zero end-to-end tests for the flip** (§3.8). The `vocab-radio` testIDs exist and are unused.
11. **Two `VoiceVocabulary` declarations** (`VoiceCoachPolicy.ts:70`, `WorkoutRecipe.ts:48`), structurally identical, independently documented, no re-export.
12. **`clickScriptManifest.ts:11` header lies:** *"Not yet wired to the runtime — click sets run coach-minimal today."*
13. **`prosody.mjs:78-82`** comment contradicts its own numbers branch (§7.3).
14. **Two orphan wavs** on disk: `assets/voice/click-scripts/cornerman3/cc-3ef58955.wav`, `cc-45bae125.wav`.
15. **Persona/rate split across banks:** click-scripts are cornerman3 @ 48 kHz; combo-announces are the old `cornerman` persona @ 24 kHz; per-token `numbers/*` and `names/*` are 24 kHz. *Within* a bank both vocabularies share a rate (verified by wav header), so **a flip never introduces a mid-playlist rate change** — which is why `tools/guards/playlist-sample-rate.mjs` stays green.
16. **Names vocabulary has no fused-body clips** at the per-token level (`assets/voice/names/standalone/` has `1.wav`…`6.wav`, no `Nb.wav`); reaching one throws (`VoiceOutputExpo.ts:1133`). Harmless only because that lane is gated off (§4.5).
17. **Docs `docs/audio-corpus.md` and `docs/audio-validation-rulebook.md`** still treat the retired 776-clip per-punch phrase bank as the primary path. Their pronunciation/ASR sections (§7) are still accurate; their lookup/lifecycle sections are not. Rulebook steps 3 and 4 cannot run (`cadence_audit.py:93`, `build_phrase_timing.py:143` both read the deleted `phraseManifest.ts`).

---

## 9. How to verify any of this

```bash
# Both vocabulary gates (the only automated coverage of the two banks' symmetry)
cd F:/punchCraft && npx jest src/domain/workout/samples/__tests__/clickCallFit.test.ts \
                             src/domain/workout/samples/__tests__/clickScriptCoverage.test.ts
# -> 10 tests, all pass (verified 2026-11-25)

# Everything voice/vocabulary-adjacent
cd F:/punchCraft && npx jest src/domain/coach src/audio/__tests__/VoiceOutputExpo.test.ts \
  src/audio/__tests__/SlotDispatcher.test.ts "src/app/(tabs)/punchcraft/__tests__" \
  src/app/settings/__tests__/voice.test.tsx src/app/qa
# -> 12 suites, 315 tests, all pass

# Regenerate the authored corpus and read the techniques translation review
cd F:/punchCraft && node --import ./tools/analysis/wav-stub.mjs --import tsx \
  tools/analysis/gen-workout-scripts.ts --corpus > corpus.json
#   corpus.json keys: leadIns(262) rests(41) calls(70) techniques{leadIns(262),rests(41)} techniqueReview(303)
#   filter techniqueReview[].notes for /RESIDUAL/ -> 36 rows (§5.2)

# Re-render only the override-broken slots (§5.4)
node tools/voice/make-click-script-clips.mjs \
  --only-keys=cc-41b6f3bf,cc-9189c64b,cc-5a20138e,cc-e17a56ba,ct-d7c94e92 --attempts=30
```

Reminders that bite here: **Metro's watcher is blind on `F:`** — every edit batch needs a Metro restart plus an app cold-restart, and after a mass wav rewrite a stale Metro breaks clip loading outright. **ffmpeg is not on PATH**; every renderer's `findFfmpeg()` falls back to a hardcoded `…Gyan.FFmpeg_…/ffmpeg-9.0-full_build/bin/ffmpeg.exe`. **The flat `persona.mjs` constants follow `ACTIVE_PERSONA` and silently ignore `--persona=`.**

## 10. If you need to change the model

The cleanest shape, in order of payoff:

1. **Collapse the five type names to one** (`'numbers' | 'techniques'` is the spelling the assets use and the one `callPlacement.ts` already imposes on the domain) and delete the six hand-written ternaries. Anything that must keep `'names'` for persisted-settings compatibility gets one adapter at the store boundary. `tools/analysis/timing-constants.mjs` regexes constants out of `callPlacement.ts` — read it before renaming anything there.
2. **Make the live flip the single source** by routing it through `voice.policy` (or a dedicated reactive ref the `SlotDispatcher` closure reads) instead of a screen-local `useState` that only reaches the click path. Keep `countdownMs` off that chain or the engine rebuild regression returns.
3. **Add the missing gates**: a residual-numeral assertion over techniques clip text, a fused-`-bee` shape assertion over numbers clip text, and one integration test for `radio → runner.setVocabulary → rebuild → next call speaks the new bank`.
4. **Either implement the downgrade or delete the four doc claims and `'converted-to-numeric'`.** Right now a reader reasonably concludes the system self-protects at high cadence; it does not — the render-time stride gate is the only protection, and techniques sits within 50–100 ms of it on seven motifs.

## Open questions

- Does `liveVocabulary` actually survive leaving and re-entering the live screen? `live.tsx:167-180` states that `(tabs)` keeps a once-visited screen mounted, which implies a flip in workout 1 silently carries into workout 2 while the recipe screen still shows the original choice — and because `startClickVocabulary` comes off the recipe, round 1's pre-bell opener would then speak a different vocabulary from every in-round call. Needs confirming on glass; no test covers it.
- Has the first call after a live flip ever been timing-measured? `preloadLight` is true on all 22 shipped workouts so the both-vocabulary warm at `VoiceOutputExpo.ts:1038-1045` never runs, and the click-script cache (keyed by `clip.module`, cap 8) has no cross-vocabulary pre-arm. The code elsewhere measures a cold native player at ~100-200 ms, which is inside the 50-100 ms techniques margin on motifs like `1b-2b-3b-2b`.
- Were the mixed-vocabulary techniques lead-ins (`lead-in/switch-by-round/r2s3`, `lead-in/speed-combos/r2s3` = "Body one, head jab, two") and the five `pump-and-coast` coast-bar lead-ins ever heard, or did the `RESIDUAL numeric` notes go unread? Fixing either side forces a voice re-render of those slots.
- Is the unfixed 4-of-same elision on `call/2-2-2-2` and `call/5-5-5-5` (techniques) and `call/3-3-3-3` (both) a known deferral or an oversight? The numbers side got the plural-rename workaround on 2026-09-11 (`9434352c`) and the techniques peers were not extended.
- Is the Settings → Voice → Vocabulary radio meant to be removed, or meant to become the authority? It currently persists a value that `live.tsx:133` discards, and its default ('names') is the opposite of the recipe default ('numbers'), so a fresh install shows the wrong selection.
- Should `voiceVocabulary` ever be pinnable per sample workout? No sample sets it today and `selectSample` does not touch the recipe, so a library pick inherits whatever the recipe screen last held — meaning a workout whose authored copy was tuned for one vocabulary can be played in the other with no signal.
