# Toolchain, stack and working methods

All of this was verified by running it on 2026-11-25.

---

## Stack (every pin exact — `.npmrc` sets `save-exact=true`)

| | |
|---|---|
| Runtime | Expo **57.0.15**, React Native **0.86.2**, React **19.2.3**, expo-router ~57.0.15 |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `noFallthroughCasesInSwitch` + `isolatedModules` |
| BLE | **`@sfourdrinier/react-native-ble-plx` 3.9.3** — a *fork* of ble-plx, chosen because upstream was unverified on the New Architecture |
| Tests | Jest (`jest-expo` preset), 180 suites / **4141 tests** / 22 snapshots |
| Node | `engines.node >= 20`; CI runs Node 24 |
| App id | `com.kyleruff.punchcraft`, URL scheme `punchcraft` |

`jest.config.js` spreads `expoPreset.transform` and adds `'^.+\.mjs$'` so
`tools/voice/prosody.mjs` can be imported. `eslint.config.mjs` applies typed and
React rules **only** to `src/**/*.{ts,tsx}` — `tools/**` is ignored, so tooling
is unlinted.

`metro.config.js` is four lines of bare `getDefaultConfig(__dirname)`. Nothing
in it mitigates the F: watch problem below.

---

## The CI gate (7 steps, `.github/workflows/ci.yml`)

`npm ci` → `typecheck` → `lint` → `jest` (`--ci --maxWorkers=2`, 6 GB heap) →
`guard:velocity-terminology` → `guard:playlist-sample-rate`.

Measured 2026-11-25: `tsc --noEmit` exit 0 · `eslint src --max-warnings 0`
exit 0 · both guards clean · jest **4141/4141** green in ~190 s.

**Guard 1** (`velocity-terminology.mjs`) hard-bans "impact speed" / "punch
strength" and flags `force|power|energy` within 5 lines of a velocity
reference. This enforces design-spec §4.3 — the tracker value is
*tracker-reported velocity*, never a physical unit.

**Guard 2** (`playlist-sample-rate.mjs`) reads RIFF `fmt` headers only (never
decodes the 660 MB corpus) across the three pools that can share a playlist.
Mixed sample rates caused ~800 ms of dead air at track boundaries — that is
what this prevents.

---

## npm scripts (14)

```
start                       expo start --dev-client
android                     expo run:android --device
prebuild / prebuild:no-clean
typecheck                   tsc --noEmit
lint / lint:fix / format
test / test:watch
guard:velocity-terminology
guard:playlist-sample-rate
kit:render                  tsx tools/tablet-voice/src/render-brass-bank.ts --kit
kit:audition                tsx tools/tablet-voice/src/render-kit-audition.ts
```

**The npm scripts are not the real loop.** The actual working loop is raw
`node tools/analysis/*.mjs` invocations driving a release APK on a
wirelessly-ADB'd tablet.

---

## The real verification loop

1. **Build release:**
   `cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`
2. **Install**, then **drive** via deep link:
   `am start -a android.intent.action.VIEW -d '<punchcraft://qa/run…>' com.kyleruff.punchcraft`
   **Always the scheme-resolved intent — never `-n <component>`**, which
   reaches the activity without the URL and silently runs the wrong thing.
3. **Judge** with two correlators:
   - `verify-first-round.mjs` (918 lines) — *content*. Exit 0 pass / 1 hard-fail
     / 2 soft-warn / 3 usage / **4 STALE**.
   - `observed-timing.mjs` (1383 lines) — *timing*, mic-free. `COVERAGE_HARD = 0.98`.
   - `verify-suite.mjs` (1000 lines) — unattended multi-workout driver.

**QA privilege model:** `autostart` and `sim` only take effect when the
*persisted* QA flag is on; `qa=1` on the link flips it. Without the flag the
public scheme merely opens the screen.

**Corpus under test:** 22 sample workouts (10 designed + 12 `quick-*`), each
with a numbers and a techniques manifest → 44 files in `tools/analysis/manifests/`.

### Launching tsx scripts that touch domain code

```
node --import ./tools/analysis/wav-stub.mjs --import tsx <script>
```

A bare `npx tsx` dies on the first `require('…wav')` inside a manifest.

---

## Working on the tablet — the three facts that bite

**Metro cannot watch `F:`.** There is no fast refresh, ever. Every edit batch
costs a Metro restart *plus* a cold app restart. A `(1 module)` 50 ms delta in
the Metro log means **you are testing old code**. Never edit source between
Metro start and the app's bundle fetch.

**`adb shell wm size` lies.** It prints portrait `1200x2000` while the app runs
landscape `2000x1200`. Taps use the *current* frame with no rotation math;
`uiautomator dump` bounds are the only authoritative coordinate source. Prefix
adb calls with `MSYS_NO_PATHCONV=1` in Git Bash, or the remote path gets
rewritten to `C:/Program Files/Git/...`.

**Pull device databases with bash, push with PowerShell.** expo-sqlite lives in
`files/SQLite/`, not `databases/`. PowerShell's `>` is text-encoding and
corrupts binary; bash redirection is byte-safe. `adb push` from Git Bash
mangles the *remote* path. Pull all three of `.db`, `.db-wal`, `.db-shm` — WAL
is on, so the main file alone looks stale.

---

## The two in-repo skills — and the risk they carry

`.claude/skills/cadence-lab/` and `.claude/skills/qa-audio-verify/` hold the
only written runbooks for the verification loop.

**`.gitignore:58` ignores `.claude/`. `git ls-files .claude` returns zero.**
They exist only on this machine, are not backed up by the repo, and a fresh
clone has neither. Parts of `cadence-lab/SKILL.md` are also stale — it names a
test file that does not exist and points at the retired phrase pipeline.

Committing these (or moving the runbooks into `docs/`) is a cheap, high-value
first task.

---

## Retired tooling that still looks live

| Tool | State |
|---|---|
| `tools/voice/make-phrase-clips.mjs` | **Deprecated** — its own header says V2 Phase 5-iv retired the per-punch corpus. The 776 clips sit in `assets/voice/phrases-legacy/`. |
| `tools/voice/cadence_audit.py` | **Guarded to refuse** — reads the deleted `phraseManifest.ts`. |
| `tools/audition/cadence_analyzer.py` (phrase half) | **Guarded to refuse.** |
| `docs/audio-validation-rulebook.md` steps 3–4 | **Cannot run.** |

---

## Test strategy

168 `.test.ts(x)` files under `src`. Heaviest areas: `domain/programs` 29,
`audio` 22, `domain` 20, `domain/workout` 16.

Project rules (`CLAUDE.md`): pure domain functions get unit tests; every
confirmed capture becomes a replay fixture; the replay harness must run on
Windows with no Bluetooth hardware; physical BLE behaviour is verified on the
tablet, never an emulator.
