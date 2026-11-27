# CLAUDE.md — working conventions for punchCraft · punchCraft workouts

Read [docs/design-spec.md](docs/design-spec.md) — and, for anything punchCraft workouts (workout model, generator, cue lifecycle, live screen, Voice Coach, persistence), [docs/workouts-ux-engine.md](docs/workouts-ux-engine.md), which supersedes spec §13 in part — before changing architecture, protocol, metrics, calibration, Spotify, or punchCraft workouts behavior. Section numbers below (§) refer to the spec; "doc §n" refers to the punchCraft workouts document.

## Non-negotiable rules

1. **Raw before parsed.** Every incoming BLE frame is persisted (`RawBleFrame`, §12.4) with a monotonic timestamp *before* any decoder runs. A parse failure never discards the payload.
2. **Dependency direction points inward** (§15.1). `src/domain/**` must not import React, React Native, Expo, SQLite, or any BLE library. React components never call the BLE library directly — they call application services/commands (§11.4).
3. **Terminology.** The value from the tracker is **tracker-reported velocity** (§4.3). Never label it impact speed, force, power, energy, or a physical unit unless a saved external-validation record exists (§10.1 Layer 4).
4. **Never write to unknown GATT characteristics.** Only reproduce writes observed from the official app; guarded writes require developer mode and a known command template (§7.2C, §12.1).
5. **Version lock** (§11.2). Expo, React Native, and the BLE library versions are locked after the Story 1 spike. Do not upgrade the Expo SDK during protocol discovery except on a separate compatibility branch; keep a known-good APK.
6. **Monotonic time for ordering and timers; wall time only for display/export** (§3.2, §18.3). The three millisecond clocks — app uptime, round work time, tracker epoch — are distinct types (`src/domain/time/clockDomains.ts`). Round time for a punch comes from `WorkoutSessionClock.workElapsedAtPunch(event)` and nowhere else; do not cast one clock into another.
7. **Decoders and calibration profiles are versioned**; stored sessions must be recalculable after a decoder change (§3.2, §8.6).
8. **Spotify** is optional, PKCE-only, tokens in SecureStore, minimal scopes, no client secret anywhere in the repo, no audio analysis or beat sync (§14). Cadence BPM is authored by the recipe on the monotonic clock — never derived from audio, Audio Features, or track metadata (punchCraft workouts doc D3).
9. **Voice Coach never speaks over third-party playback unless the user explicitly opted in** — the toggle defaults to OFF whenever Spotify or another player is active, and is never auto-enabled (§13.5, §14.6, punchCraft workouts doc D1).

## Repository layout

- `docs/` — spec, roadmap, sprint plans, dev setup, protocol notes. `docs/protocol/hypotheses.md` is the protocol hypothesis log (confidence + evidence per entry); `docs/protocol/tracker-schematics.md` is the fullest single reference for the trackers (GATT map, record layout, command table, the vendor's bond gate) — compiled 2026-09-05, with a dated note on what has moved since.
- `tools/backlog/` — backlog-as-code (`backlog-static.json`: labels, milestones, project; `backlog-issues.json`: epics + issues in 8 phase fragments) and the idempotent GitHub seeding scripts.
- `src/` — created in Sprint 1 Story 1 following §16 (`app/`, `ble/`, `protocol/`, `capture/`, `domain/`, `spotify/`, `storage/`, `state/`, `components/`, `diagnostics/`).
- `tools/pc/` — the PC version. `npm run pc:app` builds the app for a browser and serves it on this machine: it runs a workout on simulated punches and saves it (`tools/pc/app/README.md`); `npm run pc:smoke` drives that in a headless browser and is the only test of the real thing. `npm run pc:suite` is the tablet's verify suite on the PC — all 22 workouts in about 20 minutes, judged by the tablet's own correlator and by listening to what the page plays — and `npm run pc:parity` compares what it said with the tablet's captures (`tools/pc/suite/README.md`). `npm run pc:glove-check` is a separate page that runs the real start-up on a glove over Web Bluetooth (`tools/pc/glove-check/README.md`) — not yet run against a glove as of 2026-11-26, and nothing in the PC app connects one. Web-only source is a `*.web.ts` beside its sibling (`src/storage/database.web.ts` is sql.js, not expo-sqlite, kept in IndexedDB — never the private file system, which the desktop app's browser pane empties); `src/ble/gloveSupport.ts` is the one switch for "this build cannot search for gloves".
- **A tablet timing constant is never set from a PC number.** The PC suite's lateness and sound figures are the PC's own. `tools/analysis/observed-timing.mjs` refuses a capture the tablet did not write, on purpose — run on a PC capture it reported five clips cut short that had played in full and proposed moving `CALL_DISPATCH_LAG_MS`. Do not work round the refusal.
- **Two keys carry a discipline segment with boxing as its absence** (`src/domain/workout/discipline.ts`): call clips (`callSlot`, `findCallClip`) and avatar frames (`avatarFramesFor`). Build them through those functions, never by hand, and never spell `boxing` into a key. The generated clip and avatar manifests stay as they are.
- **`tools/analysis/manifests/` must match the generator.** `manifests-fresh.test.js` rebuilds all 44 in the suite; when it fails, regenerate and read the diff — an unexpected change is a timing regression, not a stale file.
- `captures/` and `artifacts/` are git-ignored local folders for raw captures and APKs. Curated replay fixtures live in `src/protocol/<adapter>/fixtures/`.

## GitHub conventions

- 38 Milestones = the roadmap (`M01`…`M30` original; `M31`…`M38` punchCraft workouts v0.2/v0.3 + workout backdrop; `M24`–`M26` superseded). 8 Epics = phases (`[EPIC] Phase N — …`, label `epic`). Every task/story/spike issue has: a milestone, a `phase:N` label, an `area:*` label, a type label, and is a sub-issue of its phase epic.
- Project board: https://github.com/users/kyleruff1/projects/5 — fields Phase, Area, Priority, Size, Sprint (2-week iterations from 2026-08-24).
- New work items: add them to the right phase fragment in `tools/backlog/backlog-issues.json` (milestones in `backlog-static.json`) and run `node tools/backlog/seed.mjs --dry-run`, then `seed.mjs`. It is idempotent by **exact title** and never updates an existing issue — retitle or close superseded ones with `gh issue edit` / `gh issue close`.
- Branch per issue (`feat/M05-02-tracker-connection`), PR title `<type>: <summary> (#issue)`, PR body `Closes #N`.
- Commit messages: conventional prefix (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`), imperative mood.

## Testing expectations (§21)

- Pure domain functions get unit tests (decoding helpers, dedup, calibration transforms, percentiles, timer transitions, stance mapping, cue matching, metric aggregation).
- Every confirmed capture becomes a replay fixture; the replay harness must run on Windows without Bluetooth hardware.
- Physical BLE behavior is verified on the tablet, never on the emulator.

## Toolchain facts (verified 2026-11-25)

Repo lives at **`F:\punchCraft`**. (`C:\Users\kyler\punchlab` is the retired location — it is no longer a git repo. Its tracker schematics were brought into the repo on 2026-11-25; what is left there is a Puncheoke schematic.)

Windows 11, Node 24, npm 11, JDK 17, `gh` authenticated as `kyleruff1`. Stack is pinned exactly (`.npmrc` `save-exact=true`): Expo 57.0.15, React Native 0.86.2, React 19.2.3, and **`@sfourdrinier/react-native-ble-plx` 3.9.3** — a fork, chosen because upstream was unverified on the New Architecture. Details in [docs/dev-setup.md](docs/dev-setup.md).

Three environment facts that cost real time if unknown:

1. **Metro cannot watch `F:`.** Fast refresh never fires. Every edit batch needs a Metro restart *and* a cold app restart; a `(1 module)` delta in the Metro log means you are testing OLD code. `npm run tablet:reload` does both and waits for the app — written without a tablet attached, so treat it as unproven until you have watched it work.
2. **`adb shell wm size` lies** — it reports portrait while the app runs landscape. Taps use the current frame with no rotation math; `uiautomator dump` bounds are authoritative. Prefix adb with `MSYS_NO_PATHCONV=1` in Git Bash.
3. **`.claude/` is gitignored except `.claude/skills/`**, which holds the `cadence-lab` and `qa-audio-verify` runbooks — the only written record of the verification loop. They are tracked as of 2026-11-25; before that a fresh clone had neither. Everything else under `.claude/` (worktrees, local settings) stays out.

**Before you commit.** `npm run check` is the fast half of CI (typecheck, lint, format, guards; about 20 s) and runs on every push once `npm run hooks:install` has been run in the clone. Text is LF and `src/**/*.{ts,tsx}` and `tools/pc/**` must be Prettier-clean — run `npx prettier --write` on what you touched. Two groups are exempt and must be left exactly as committed: the generated manifests and the Puncheoke paths (`.prettierignore`, `.gitattributes`). `npm test` is quiet by default; `JEST_LOGS=1` brings the app's logging back. A stored setting is read with `SettingsRepository.readChecked`, never `read`. More in [docs/dev-setup.md](docs/dev-setup.md).

## Start here for a new session

[docs/handoff/00-START-HERE.md](docs/handoff/00-START-HERE.md) — orientation, architecture map, the coach-vocabulary and beat-mapping references, the verification runbook, ranked review targets, and the roadmap for non-boxing workout types. It also lists the four sources in this repo that are known-stale and will mislead you (this file's own GitHub section among them — see below).

## Known drift (2026-11-25)

- The **PR-per-change workflow below was abandoned mid-September**: the last 15 commits on `main` went in directly, with no PR. An open issue is therefore *not* evidence of unbuilt work — verify against the code.
- `tools/voice/README.md`, `docs/audio-corpus.md` and `docs/audio-validation-rulebook.md` all describe the per-punch phrase-clip pipeline as the live path. (`README.md` does not mention it; what is stale there is the status line — "planning complete", 30 milestones.) It was **retired** in V2 Phase 5-iv (`369a2c6`). `src/domain/coach/callPlacement.ts`'s doc comments are the current, mic-measured record.
- The **bonding requirement** — trackers must be paired as "FightCam" or every link dies at ~37 s — is the most important operational fact about the hardware. It is **H13** in `docs/protocol/hypotheses.md`; the tablet timing there is reported, not re-measured. The app now recognises the signature (`src/ble/bondDiagnosis.ts`) and says "Not paired?" after two such drops — tested against the timing rule, never yet against a glove.
