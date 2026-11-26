# Architecture map

Where things live and how a punch becomes a score. Every path verified at HEAD
`8b7e79a2`.

---

## The one-way dependency rule

`CLAUDE.md` rule 2 (design-spec §15.1): **`src/domain/**` must not import React,
React Native, Expo, SQLite, or any BLE library.** React components never call
the BLE library — they go through services. This holds today and is the reason
the domain is unit-testable on Windows with no hardware.

```
src/ble/          transport — the ONLY place a BLE library is imported
   ↓
src/protocol/     adapter + pure decoder + per-device stream orchestration
   ↓
src/domain/       normalized events, cue timeline, matching, scoring, coach
   ↓
src/storage/      SQLite persistence
```

---

## Path 1 — a glove hit becomes a scored event

| Step | Where |
|---|---|
| Indication on `ca281069` | `src/ble/BleManagerBlePlxImpl.ts` (820 lines; only importer of ble-plx 3.9.3) |
| Stamped `performance.now()` **inside** the native callback | same |
| **Persisted before any parsing** (rule 1) | capture sink |
| Split into 9-byte records | `src/protocol/fightcamp-v1/FightCampV1Decoder.ts` (pure, no I/O) |
| Emitted as `TrackerPunchEvent` | `src/protocol/TrackerPunchEventSource.ts` |
| Matched against the active cue | `src/domain/programs/CueMatcher.ts` |
| Scored | `src/domain/programs/cueScoring.ts` |

**Hand comes from the connection slot, not the payload.** `src/ble/knownTrackers.ts`
holds the hard-coded address→hand assignment for the two gloves.

**The decoder refuses to classify technique.** H11 confirmed the byte layout
from the decompiled Hykso APK; **H12** then settled on hardware that the type
byte carries no device-portable meaning. Capability tier is pinned at
`hand-timestamp`, so **all cue scoring is hand-sequence only** — and every
scoring surface must say so rather than claim technique accuracy.

**Also true:** the tracker transmits nothing below an acceleration floor, so a
soft strike does not exist to the app. Matching must distinguish *dropped
because soft* from *missed the window*.

---

## Path 2 — a recipe becomes a cue timeline

```
WorkoutRecipe
  → generateWorkout()            src/domain/workout/generateWorkout.ts (200 lines)
  → roundFill.fillScoredRound()  src/domain/workout/roundFill.ts (735 lines — the real generator)
  → GeneratedWorkout { ProgramRound[] }
  → expandTimeline()             src/domain/programs/CueTimeline.ts  ← ALL beat→ms math, once, at load
  → CueEngine.tick(workElapsedMs) src/domain/programs/CueEngine.ts
       statuses: queued → previewing → announcing → active → accepting
  → LiveCueMatcher → cueScoring
```

`ProgramRound[]` is the real contract boundary — everything downstream consumes
it. `WorkoutTokens.ts` (372 lines, **import-free**) is the root of the graph.

**Two content paths ship simultaneously:** picking a library workout runs a
hand-authored **click map** (`samples/clickMaps.ts`, 10 designed + 12 `quick-*`
= 22); picking nothing runs the **seeded generator** over the 60-combo corpus
(`corpus/comboCorpusV1.ts`). `GENERATOR_VERSION = '1.2.0'`.

---

## Path 3 — the coach speaks

**There are two generations side by side**, and which one calls the punches is
decided by the workout's authored coach path (until 2026-11-25, by
`WorkoutRecipe.voiceMode` — see below):

| | **(A) V2 "score" path** | **(B) Script-Bible-v2 "click-script" path** |
|---|---|---|
| Fires when | the workout is not a click-script workout (`coachPathOf(workout) === 'score'`) | on any bar the click-script bank has a clip for — in practice the library's motifs |
| Chain | `CueAnnouncer` → `RhythmMap` → `compileWorkoutScore` → `SlotDispatcher` | `_useWorkoutRunner.buildLeadInSchedule` → `callPlacement.ts` |
| Bank | 218-clip `comboAnnounceManifest` | 736-clip `clickScriptManifest` |
| **In practice** | **not on the 22 library workouts; live on generated ones** | **this is what you hear on the library** |

**Every one of the 22 library workouts is a click-script workout**, and the
runner arms the SlotDispatcher only when a workout is not one
(`scoreDispatchEnabled` in `_useWorkoutRunner.ts`). So on the library the
SlotDispatcher is unarmed — internalize that before debugging audio there, or
you will instrument a path that never fires.

**It is not dormant everywhere.** An earlier draft of this page said the score
path "never runs on shipped content". It runs on `diagnostic-token-sequence`
(a registered, runnable sample) and on every **generated** workout, which is
what the recipe screen builds. A bug in the score path is a bug an athlete
can reach.

**How a workout says which path it is on** (changed 2026-11-25): an authored
`coachPath: 'click-script'` on the workout, read through `coachPathOf`
(`src/domain/workout/GeneratedWorkout.ts`). Until then the marker was
`recipe.voiceMode === 'minimal'`, which made the athlete's "how chatty is the
coach" setting double as "this is a click-track workout". Pages 03, 04 and 06
still quote the old `voiceMode !== 'minimal'` test; read those as
`coachPathOf(workout) !== 'click-script'`.

A third generation, the 776-clip **per-punch phrase corpus**, was retired in V2
Phase 5-iv (`369a2c6`): `playCombination()` is a hardwired `return false` and
the wavs live in `assets/voice/phrases-legacy/`.

---

## Path 4 — the clock

Two layers with a clean seam:

**Live path (drives a workout):**
`WorkoutSessionClock` (phase machine; `workElapsedMs` freezes on pause) →
`expandTimeline` (beats→ms once, at load) → `CueEngine.tick(workElapsedMs)` →
`LiveCueMatcher` → `cueScoring`.

**M39-V2 "one score" stack (partly load-bearing):** `TimingEngine` (960-tick
transport) → `programCueBridge` → `compileCue` → `workoutScore` →
`SlotDispatcher`, plus `MetronomeTransport` / `SharedTransportAnchor`. The
compiled score drives combo-announce dispatch and the avatar's transport
anchor; **rings and scoring still run off the session clock in milliseconds.**

The ring walk moved onto the UI thread (`SharedWorkClock` + `useRingBeatClock` +
`beatOrdinalAtMs`) as a pure projection — that is the fix for the 2026-08-31
catch-up-burst strobe.

See `04-beat-mapping-and-offsets.md` for every constant.

---

## Dead at runtime (wired, tested, never executed)

Knowing these saves hours:

- `src/domain/timing/acceptance.ts` — `EXPECTED_STRIKE_DELAY_MS=140`,
  `ACCEPT_FROM_MS=60`, `ACCEPT_UNTIL_BASE_MS=400`. Consumed only by
  `TimingEngine.scheduleCombination`, which nothing calls.
- The whole **swing / RhythmicCombination** half of `TimingEngine`.
- The **cadence rail** — the runner passes `wordMarksFor: () => undefined` and
  `phraseShiftFor: () => undefined` (`_useWorkoutRunner.ts:477-478`, again at
  `:1719`), so the "ring N lights 120 ms after word N's envelope ends" contract
  is inert.
- **`PacingEngine`** proposes but nothing applies — only `decision.cueText` is
  consumed; the timeline is `useMemo`'d and never rebuilt.
- `StanceMapper.resolveSequence` / `handSequence` — no production caller.

---

## Out of scope: the Puncheoke instrument

Forked to its own product, code still physically present:
`src/domain/instrument/` (29 files, ~6k lines), `src/instrument/bridgeClient.ts`,
`src/app/(tabs)/puncheokie/` (the tab *is* the instrument surface),
`docs/puncheoke/` (10 design docs), `tools/punchbridge/`.

It keeps the `puncheokie` identifiers deliberately — expo-router matches the tab
`name` to the on-disk directory and the wordmark key indexes `PunchEoke.png`.

**It shares nothing with the workout engine above the tracker.** Grepping
`src/domain/instrument` + `src/app/(tabs)/puncheokie` for
`CueTimeline|expandTimeline|ProgramRound|WorkoutSessionClock|CueEngine` returns
**zero hits**; the single shared import is `getTrackerKeepaliveSource`. Excising
it is clean whenever you want to.

Note it already re-declared its own `StrikeToken` and a **divergent**
`StrikeFamily` (`'straight'|'hook'|'uppercut'` vs the engine's
`'jab'|'cross'|'hook'|'uppercut'`). That drift is the cautionary tale for
`07-new-workout-types.md`: forking the vocabulary has been tried here once and
it produced two enums that disagree.
