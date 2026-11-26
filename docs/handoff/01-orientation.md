# Orientation

## What this is

**punchCraft** is an Android-first Expo app that revives two unsupported
**FightCamp v1 (Hykso)** Bluetooth punch trackers. Started 2026-08-22 as
"PunchLab"; renamed punchCraft 2026-08-23.

Two modes ship:

- **Velocity Lab** — the engineering surface. BLE permissions, scan, connect,
  GATT inventory, live decode, raw-frame capture and export. Built first on
  purpose: it had to exist before any product UI, because the protocol was
  unknown and had to be reverse-engineered from a decompiled Hykso APK.
- **punchCraft workouts** — the product. A coached, click-tracked boxing
  workout: generated or hand-authored rounds, a cue timeline, a voice coach
  with two vocabularies, ring/avatar animation, live hand-sequence scoring and
  a persisted summary.

A third thing, the **Puncheoke instrument**, was forked out to its own product
and is out of scope here (see `02-architecture.md` for what remains in-tree).

---

## Current state — read this before planning

| | |
|---|---|
| Repo | `F:\punchCraft` · remote `github.com/kyleruff1/punchCraft` |
| `main` | `8b7e79a2`, **2026-09-26** |
| Working tree | Clean (one untracked `assets/branding/Kyle Ruff.lnk`) |
| CI | `main` green: 180 suites / **4141 tests** / 22 snapshots; typecheck, lint and both guards clean. The PR that carried this package (390) was **red** when this was written — it failed `guard:velocity-terminology` on `05-toolchain-and-methods.md`, the page that quotes the guard's own banned list |
| Issues | 107 open across 18 milestones; 241 closed |
| Open PRs | One when written — 390, this package. (This row said "Zero".) |

**The repo is dormant, not mid-flight.** Nothing is half-finished. You are
starting a cycle.

**The PR workflow was abandoned mid-September.** `CLAUDE.md` prescribes
branch-per-issue with `Closes #N`, and PRs #233–#379 followed it — but the last
**15 commits went straight to `main`** with no PR. Consequence: *an open issue
is not evidence of unbuilt work.* Several things the tracker shows open are
shipped. Verify against the code before picking anything up.

**38 remote branches** were never deleted after merge. Project v2 #5 has gone
stale — 43 open issues were never added to it.

The last live thread was the **M45 PC-direct BLE spike (#387)**, effectively
complete with one box open, having spawned #388 / #389.

---

## What has actually shipped

The engine is further along than the tracker suggests. Verified present and
tested at HEAD:

- **Protocol** — byte-level confirmed decoder (H11, from the decompiled Hykso
  APK), 8-step Hykso start-session init plan, 20 s keepalive, bonded-pair
  connection, raw-before-parsed capture to SQLite.
- **Workout model** — `WorkoutToken` / `WorkoutBlock` / `ProgramRound`
  contracts, combo notation (`parseCombo` / `formatCombo`), a 60-combo
  authored corpus, 22 hand-authored click workouts, and a seeded generator
  (`GENERATOR_VERSION 1.2.0`) that fills every scored round to the bell.
- **Cue engine** — beat→ms expansion at load, cue lifecycle
  (queued→previewing→announcing→active→accepting), live matching, scoring,
  round transitions, pause semantics.
- **Voice coach** — a pre-rendered clip bank with **two complete vocabularies**
  (numbers and strike names), live switchable mid-round; lead-ins, per-bar
  calls, rest scripts, ceremony playlists.
- **Animation** — ring walk on the UI thread, two-frame avatar, membrane
  backdrop.
- **Verification** — unattended on-tablet drive harness with content and
  timing correlators, plus ~319 captured drives as regression baselines.

Most of the hard-won value in this project is **measured timing constants and
settled rulings**, earned over on-glass sessions. `04-beat-mapping-and-offsets.md`
is where they live. Treat them as expensive.

---

## The hardware

Two FightCamp v1 trackers: **blue = left**, **red = right** — a permanent,
hardcoded mapping (`src/ble/knownTrackers.ts`), not a user choice. Auto-connect
binds both on launch.

**The trackers must be BONDED.** Unpaired, the glove's Security Request plus a
30 s SMP timeout kills every link at ~37 s — which is why the official Hykso
app appears to round-robin between gloves. Pair once as "FightCam" and both
hold. **When this was written the fact existed only in a memory file; it is
now H13 in `docs/protocol/hypotheses.md`.** It is the single most important operational
fact about the hardware and it belongs in the repo.

Tablet: Lenovo TB125FU over wireless ADB. It blocks HCI snoop logging (H08),
later worked around via `adb bugreport`.

---

## Where the authority lives

| Question | Source |
|---|---|
| Architecture, protocol, metrics, terminology | `docs/design-spec.md` (§-numbered; cited throughout the code) |
| Workout model, cue lifecycle, live screen, voice, persistence | `docs/workouts-ux-engine.md` — **supersedes spec §13 in part** |
| Protocol findings + confidence | `docs/protocol/hypotheses.md` (H-numbered) |
| Working rules | `CLAUDE.md` — 9 non-negotiables |
| Timing truth | `src/domain/coach/callPlacement.ts` doc comments — mic-measured, more current than the audio docs |

**Known-stale:** `tools/voice/README.md`, `docs/audio-validation-rulebook.md`,
and `docs/audio-corpus.md` all describe the retired phrase pipeline.
`README.md` does not mention it (it was listed here in error); its status line
is what is stale. `CLAUDE.md`'s toolchain section was dated 2026-08-22 and
pointed at the old `C:` path when this was written; it has since been
re-verified (2026-11-25).

---

## How Kyle works

Worth knowing before you propose anything:

- **His ear outranks the correlator.** The analysis harness is evidence, not a
  verdict. If a number says pass and it sounds wrong, it is wrong.
- **Diagnose to a named root cause before fixing.** Fix-then-see is not the
  loop; the loop is diagnose → fix → drive on glass → record closer/farther in
  the workout's GH issue.
- **Settled rulings stay settled.** Several memories mark decisions explicitly
  "do not re-litigate" (stance values, `gapBeats` naming, lowercase `b`
  serialization, avatar opacity/height, metronome as removable instrumentation).
  Reopening them without new evidence wastes a session.
- **Never blanket-change phrase tempo** — words are fitted to strikes. Energy
  comes from delivery, not speed.
- **When the tablet or audio loop is blocked, offer code-only work** rather
  than waiting.
