---
name: qa-audio-verify
description: >-
  The unattended audio-verification loop for punchCraft's coach (GH #291,
  #292, #283). Drives every sample workout on the tablet with nobody in the
  room — QA deep link, autostart, simulated punches, muted speaker — and
  judges each one with the first-round correlator plus the silent timing
  observers. Use whenever the user says verify suite, run the suite, full
  suite, release baseline, LOOP ledger, "drive all 22", "is body-work still
  clean", or wants timing numbers (onset latency, breath, ceremony gaps)
  without a microphone. Pairs with cadence-lab (which tunes the rail) — this
  skill produces the measurements that skill consumes.
---

# QA audio verify

## What it is

`tools/analysis/verify-suite.mjs` runs the 22 sample workouts (10 designed +
12 quick) end to end on the tablet and writes one verdict per drive. Nothing
is heard: the media stream is muted for the run and restored after, and the
timing evidence comes from two silent observers that only exist under the
persisted QA flag —

- the **coach playhead observer** (`workout.voice.observed`): every clip,
  ceremony playlist and metronome loop reports dispatch → onset → end on the
  same `performance.now()` clock as `cue.tokenDue`;
- the **instrument onset tap** (`workout.instrument.observed`): the Oboe
  engine's zero-gain analyser reports trigger → first rendered frame per
  punch.

The verifier (`verify-first-round.mjs`) still judges round 1; the suite adds
whole-session health counters, AudioTrack readings at arm and at end, and
the observers' summary beside every verdict.

## Preconditions

1. **Tablet paired over wireless ADB** and awake-able: `adb devices` shows
   one `device` row. The suite wakes it and dismisses the (insecure)
   keyguard itself.
2. **QA mode is on** for the installed app: open the app → **Settings → QA
   mode** and switch it on. Once per install — it persists, including across
   the dev-client ↔ release swap in the loop below. **A link can no longer
   do this** (it could until 2026-11-25: `qa=1` on the deep link set the flag
   and then used it, so anything able to open a link could start a simulated
   workout that was saved as a real session). A link can still switch it
   *off* (`qa=0`). If a drive reports `qa-flag-off`, the switch is off —
   `workout.qa.run.blocked` in that capture confirms it, and
   `workout.qa.run.cannotEnable` means a link asked to turn it on.
3. **Which build?**
   - *Dev client* (default, `--launch=warm`): Metro must be running on the
     LAN, and every clip is an HTTP fetch from Metro — a first-order
     contaminant for onset latency. Fine for functional verdicts, not for
     timing baselines.
   - *Release APK* (`--expect-release`): assets bundled, no dev launcher.
     **Every timing baseline and every `--gh-ledger` run uses this.**
4. **Manifests are current**: after any change to a workout, a click map,
   or the score compiler, regenerate —
   ```bash
   node --import ./tools/analysis/wav-stub.mjs --import tsx tools/analysis/first-round-manifest.ts --all
   node --import ./tools/analysis/wav-stub.mjs --import tsx tools/analysis/first-round-manifest.ts --all --vocab=techniques
   ```
   A stale manifest is not fatal — the suite regenerates and re-drives once
   on a STALE verdict — but a whole-suite regen beforehand saves ~10 min per
   stale row.
5. Nothing else needs the tablet's audio for the next few hours. Budget:
   full sessions ≈ 4.4–5.3 h for 22 (`--dry-run` prints the worst case);
   `--first-round-only` ≈ 2 h; `--vocab=both` doubles either.

## The loop

```bash
# 1. Build the release APK (arm64 only — the tablet's ABI; ~10 min).
#    Or download the one CI built for the commit: the `release apk` workflow
#    runs on every push to main and keeps `punchcraft-release-<sha>` for seven
#    days. Same signing key as a local build, so step 2 works unchanged.
#    (As of 2026-11-25 that workflow had not yet been seen to pass.)
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a && cd ..
cp android/app/build/outputs/apk/release/app-release.apk artifacts/punchcraft-release-$(git rev-parse --short HEAD).apk

# 2. Install over the dev client (same applicationId, same debug keystore —
#    the DB and the persisted settings survive).
adb install -r artifacts/punchcraft-release-$(git rev-parse --short HEAD).apk

# 3. Plan, then run. --gh-ledger appends a row to every [LOOP] issue.
node tools/analysis/verify-suite.mjs --all --expect-release --dry-run
node tools/analysis/verify-suite.mjs --all --expect-release --gh-ledger

# 4. Read the summary.
#    tools/analysis/suites/<epoch>/summary.md   (one row per drive)
#    tools/analysis/suites/<epoch>/summary.json (everything, machine-readable)
#    tools/analysis/suites/<epoch>/<workout>/   (logcat, verify-report, observed-summary, drive.json)

# 5. Swap the dev client back when you are done measuring.
npm run android
```

The suite mutes the media stream (`cmd media_session volume --stream 3
--set 0`, keyevent fallback) and restores it on exit and on Ctrl-C. Pass
`--keep-volume` to leave it alone.

### Single-workout quick check

```bash
node tools/analysis/verify-suite.mjs --only=body-work --first-round-only
node tools/analysis/verify-suite.mjs --only=quick-one-two --vocab=both --expect-release
```

Useful flags: `--sim=alternating-1-2` (matcher-only punches; default
`captured-jam` exercises both hands and the acceleration axis),
`--sim-force` (gloves on but the sim must drive), `--sim-bpm=N`
(override the pace; default matches the workout's estimated punches per
minute), `--tap-fallback` (dev builds only: tile → quick-start → radio →
Hit It when the deep link never lands), `--out=<dir>`.

The observers' numbers for one capture, on their own:

```bash
node tools/analysis/observed-summary.mjs --session tools/analysis/suites/<epoch>/body-work
```

## Verdict legend

| Verdict | Meaning | Suite exit |
|---|---|---|
| PASS | verifier exit 0 — round 1 correlated clean | 0 |
| WARN | verifier exit 2 — audible but drifted (late rows, soft warnings) | 2 |
| STALE | verifier exit 4 after one manifest regen + re-drive — the installed bundle's timeline ≠ this checkout's | 4 |
| FAIL | verifier exit 1 (hard-zero regression), or `build-mismatch` under `--expect-release` | 1 |
| ERROR | the drive never reached a judged round: launch failed, no autostart, no countdown, cancelled, exception | 1 |

A drive that reaches round 1 but times out before its last boundary keeps
the timeout in `reason` while the verifier's verdict stands for round 1.

**What the verifier gates on a library (click-script) workout** — changed
2026-11-25, so verdicts from before that date are not comparable. Those
workouts never arm the score dispatcher, so the combo-announce gates have
nothing to correlate. They are judged on what the click script did instead:

- FAIL if any playback failed or a clip was missing, or if calls were
  expected and **none** was dispatched.
- WARN if fewer than 90 % of the expected calls were dispatched
  (`CALL_COVERAGE_LOW_PCT`), or if the run's identity could not be
  established — no `workout.timeline.provenance` record to check the
  installed timeline against the manifest.

The `Test-drive results` row a `--gh-ledger` run appends carries compact
stats (`matched=… late=… extra=… reanchor=…`); **Closer?** compares the
mismatch total with the previous row (`closer` / `farther` / `same` /
`first`).

## Failure playbook

| Symptom (`reason`) | Where to look | Usual cause |
|---|---|---|
| `launch-failed: app.ready never logged` | is the dev-launcher picker up? `adb shell dumpsys window \| grep mCurrentFocus`; Metro reachable? | Metro down or the picker needs a tap — use `--tap-fallback`, or install the release APK |
| `launch-failed: qa.run never logged` | `logcat.txt` for `Running "main"` and `workout.app.ready` | the intent used `-n <component>` (never do), or it arrived before `app.ready`; the suite re-sends once |
| `qa-flag-off` | `workout.qa.run.blocked` in the capture | QA mode is off on the tablet — switch it on in the app (Settings → QA mode) and re-run; a link cannot do it |
| `no autostart` | `workout.runner.start` present? `phase`/`roundCount` at arm | the live screen never reached `idle` with a schedule; check `workout.qa.run` `workout` |
| `tracker-when-sim-expected` (WARN line) | `runner.start` `source` field | gloves are on and live wins unless `--sim-force` |
| AudioTracks at end ≥ 40 | `drive.json` `audioTracks`, `tools/analysis/audiotrack-count.sh --watch` | a native handle leak — GH #356 territory; the caps in VoiceOutputExpo bound it at 36 + the one-shot lane |
| `build-mismatch` | `qa.run` `dev`/`gitSha` | a dev client is installed; run step 1–2, or drop `--expect-release` |
| `gitSha ≠ host` (WARN line) | `qa.run` `gitSha` vs `git rev-parse --short HEAD` | the installed build is another checkout — timing numbers are not comparable across it |
| `timeout: no transition …` | last `workout.round.boundary` in the capture | the app crashed (`AndroidRuntime` count), was backgrounded, or the tablet dozed mid-session |
| `observed: no observer records` | `workout.observer.stats` absent | the QA flag was off when `VoiceOutputExpo` was constructed — the flag is read at construction; re-run |
| coverage < 98 % | `observed-summary.json` `playsWithId` vs `voiceObserved` | plays evicted before onset, or the observer's onset timeout (4 s) fired — look at `outcome` tallies |

## What the numbers feed

- **Onset latency by `path`** (`armed` vs `fresh`) sizes
  `ONE_SHOT_RELEASE_PAD_MS` and `DEFAULT_CALIBRATED_AUDIO_OUTPUT_LATENCY_MS`
  (`src/audio/VoiceOutputExpo.ts`). Compare release against dev: the
  release numbers are the truth, dev carries Metro's fetch.
- **Ceremony records** (`intro`, `round-warning`, `recovery`, `metronome`)
  join to `workout.round.boundary.monotonicTimeMs`: bell onset latency,
  warn-end → bell (target 0–400 ms; negative = the bell cut the countdown),
  recovery end → warn onset (> 0 required).
- **Call breath** = `firstNodeMs − observed call end`, per slot — the input
  to `DENSE_BREATH_MS` / `MIN_BREATH_MS` / `CALL_BREATH_OVERRIDES`
  (`src/domain/coach/callPlacement.ts`), which is the rail constant for
  click-track workouts (plan C6).
- **Instrument** median/p95/jitter and the masked/busy ratio: jitter is the
  gate, the median only sets lead times.
- `observer.stats.maxHandlerMs` proves the observer's own cost.

The full analyzer with joins and tuning proposals is
`tools/analysis/observed-timing.mjs` (see the cadence-lab skill);
`observed-summary.mjs` is the quick per-capture view.

## Files this skill owns

- `tools/analysis/verify-suite.mjs` — the driver (+ `__tests__/verify-suite.test.js`)
- `tools/analysis/observed-summary.mjs` — the observers' per-capture summary
- `tools/analysis/logcat.mjs` — record stitching shared by every analyzer
- `tools/analysis/first-round-manifest.ts` — manifests with the session shape (`roundCount`, `scheduleMs`, `estimatedActivePunchesPerMinute`)
- `tools/analysis/audiotrack-count.sh` — the AudioTrack readings
- Runtime: `src/app/qa/run.tsx` (the deep link), `src/state/useQaStore.ts` (the persisted flag), `src/audio/PlaybackObserver.ts`, the tap in `src/audio/InstrumentVoiceOutputOboe.ts`
