---
name: cadence-lab
description: >-
  The audio-visual sync bench for punchCraft's shot-caller. Owns the rail
  contract — "ring N lights K ms after word N's audible envelope ends" —
  and the measurements that tune it. Use whenever the user says cadence
  lab, call-vs-ring, offset audit, mapping cadence, misalign combos, "the
  coach is off the rings on X-Y-Z", or after ANY phrase-clip or call-clip
  re-render batch. Pairs with qa-audio-verify, which produces the captures
  this skill reads.
---

# Cadence Lab

## The contract

**Ring N lights `RAIL_K_MS` (120 ms) after word N's audible envelope ends.**
Cross-vocab consistency follows from `K` being global — numbers and
techniques inherit the same lag by construction.

## Runtime status — READ FIRST (2026-09-07)

**The rail is not engaged at runtime.** Do not diagnose a drift report as a
rail failure until this changes:

- The workout runner passes `wordMarksFor: () => undefined` and
  `phraseShiftFor: () => undefined` (the `compileRoundRhythmMap` options in
  `_useWorkoutRunner.ts` — search `wordMarksFor`), so the placement half
  never receives marks.
- `CueEngine.fireDueTokens` reads `cue.tokenOffsetsMs` only — the
  `phraseTokenTimesMs` override this skill used to describe was retired in
  V2 Phase 5-ii. `CueInstance` (`CueTimeline.ts`) carries no per-token
  override.
- The 218 combo-announce clips have no speech marks, and the click-script
  call clips have none either.

So rings are on the beat grid, everywhere, today. What *does* exist:

- `compileRoundRhythmMap` (`RhythmMap.ts`) still computes rail placement when
  handed marks — search `opts.wordMarksFor`. The placement half is starved,
  not missing.
- `compileRoundSpine` already computes rail times (`TokenBeat.atMs` /
  `audioAtMs` / `audioEndMs`, via `beatsFor` → `timingFor(cue)` in
  `RhythmSpine.ts`).
- Per-token word onsets and ends survive for **562 of 776 clips** in
  `src/domain/programs/phraseTimingManifest.ts`.

Wiring it is plan C6 (two prongs: word marks on the call clips + placement
by last-word end for click-track workouts; `wordMarksFor` over
`phraseTimingManifest` + the `CueEngine` reader for generated workouts).

## The loop

```bash
# 1. LIVE, MIC-FREE — the standing check. Drive a workout with QA mode on
#    (Settings → QA mode, once per install; see the qa-audio-verify skill),
#    then:
node tools/analysis/observed-timing.mjs --session <sessionDir>
#    Measures, from the silent playhead observer (GH #291): per-slot call
#    breath (observed call END → the bar's first punch), combo-announce end
#    → first ring, lead-in end vs its endBy budget, ceremony gaps, onset
#    latency per family and path. Writes observed-timing-report.{json,md}
#    with `proposals` — the constants to move, and by how much.
#    Exit 0 clean / 1 hard (coverage, truncation) / 2 soft.

# 2. WHOLE SUITE — 22 workouts unattended, one summary.
node tools/analysis/verify-suite.mjs --all --expect-release
#    → tools/analysis/suites/<epoch>/summary.md

# 3. CONSTANTS — regenerate whenever cadence.ts, the rhythm map, or a
#    breath/lead constant changes. Every analyzer reads this, never a literal.
node tools/voice/build-cadence-grid.mjs      # also writes timing-constants.json
node tools/analysis/timing-constants.mjs     # constants alone

# 4. RAIL VERIFICATION — once C6 lands marks, this proves rings follow them.
node --import ./tools/analysis/wav-stub.mjs --import tsx \
  tools/analysis/phrase-timing-dump.mjs      # per-token marks → JSON
F:/voice-tools/venv/Scripts/python.exe tools/audition/rail_verify.py <sessionDir>
#    Today it exits 3 with "the rail is INERT, not broken" — that is correct
#    and expected, not a parse failure.

# 5. MIC — Tier-2 only, when the schedule is provably right and the audio
#    still reads drifty (a clip-render question, not a rail one).
node tools/audition/monitor-session.mjs --duration=25 --out=tools/analysis/monitor/cadence-<date>
F:/voice-tools/venv/Scripts/python.exe tools/audition/cadence_analyzer.py <sessionDir>
```

## Fixing a clip that reads badly

> **Stale — read before using (noted 2026-11-25).** This section is the
> workflow for the per-punch **phrase corpus**, which V2 Phase 5-iv retired
> (`369a2c6`). `tools/voice/make-phrase-clips.mjs` is marked DEPRECATED and
> nothing at runtime plays those clips. It is kept because the per-token
> marks it produced are what plan C6 would feed the rail; it is not a way to
> fix a call clip a workout plays today. The live bank is the click-script
> manifest (`src/audio/voiceAssets/clickScriptManifest.ts`).

Diagnose by `wordMarksSource` in the phrase-timing dump:

| Source | What it means | Fix |
|---|---|---|
| `envelope` / `envelope-relaxed` + high spread | the coach ran words together on this cadence | re-render at a slower cadence, or respell in `overrides.json` |
| `whisper` + high spread | Whisper's word times are coarse (±100 ms) | re-render at a different exaggeration, or split the phrase text with commas so the envelope detector finds distinct onsets |
| `none` | no marks — the clip falls back to the beat grid | push it through `make-phrase-clips.mjs` again (it runs all three sources); still `none` means the audio is genuinely too compact for per-word timing |

Escape hatch for one clip that works everywhere else:
`tools/voice/clip-shifts.json` + `PhraseAsset.startPadMs`. Note the runtime
does not read it yet (`phraseShiftFor` is stubbed — plan C6). Fill only for a
clip whose live reading Kyle confirms.

## When NOT to reach for the rail

- Cross-vocab drift on the same combo persists → the beat grid is not the
  culprit and `RAIL_K_MS` will not fix it; diagnose the clip's audio.
- Drift is worse on certain cadences of the same combo → re-render that
  cadence.
- Kyle's ear says a pass is drifty but measured `endToRing` is uniform → the
  rail is doing its job and `K` may be wrong.

## Rerun triggers

- After ANY phrase- or call-clip re-render batch. `tools/voice/phrase_token_audit.py`
  is Tier-0; the live `observed-timing.mjs` pass is Tier-1.
- After any change to `cadence.ts`, `RhythmMap.ts` (`RAIL_K_MS`, placement),
  or the runner's breath/lead constants — regenerate `timing-constants.json`
  and re-measure.
- On a Kyle report ("at 1:45 the 1-2-3 drifted"): run `observed-timing.mjs`
  on the most recent capture and filter the breath table to that slot.

## Files this skill owns

- **Live measurement (mic-free, the standing loop)**
  - `tools/analysis/observed-timing.mjs` — the analyzer + proposals
  - `tools/analysis/observed-summary.mjs` — the per-capture summary
  - `tools/analysis/timing-constants.mjs` — constants read from TypeScript
  - `tools/analysis/phrase-timing-dump.mjs` — per-token marks → JSON
  - `tools/audition/logparse.py` — shared log record shapes (Python side)
- **Runtime (the rail contract)**
  - `RAIL_K_MS` in `RhythmMap.ts` (and its copy in `RhythmSpine.ts` — the
    constants dump warns when they drift apart)
  - placement: `compileRoundRhythmMap` in `RhythmMap.ts` · spine times:
    `beatsFor` / `timingFor` in `RhythmSpine.ts`
  - the ring reader that must change for C6: `CueEngine.fireDueTokens`
  - `PhraseTimingWord.onsetMs` / `.endMs` + `wordMarksSource` in
    `src/domain/programs/phraseTimingManifest.ts`
- **Instrumentation** (safe in production, QA-flag-gated)
  - `workout.cue.tokenDue` (carries `scheduledMs` + `monotonicTimeMs`)
  - `workout.voice.observed` — real onsets and ends (GH #291)
  - `workout.clickScript.dispatch` — `traceId`, `endByMs`, `firstNodeMs`
- **Tests**: `src/domain/programs/__tests__/RhythmSpine.test.ts`,
  `mapCallShifts.test.ts`, `tools/analysis/__tests__/observed-timing.test.js`
- **Retired, guarded so they say so**: `tools/voice/cadence_audit.py` and the
  phrase-play half of `tools/audition/cadence_analyzer.py` — both measured the
  per-punch phrase corpus deleted in V2 Phase 5-iv (`369a2c6`).
