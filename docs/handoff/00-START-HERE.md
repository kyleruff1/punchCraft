# punchCraft — session handoff

**Written 2026-11-25.** Repo at `F:\punchCraft`, `main` = `8b7e79a2` (2026-09-26).
Produced by an 11-agent research pass that read the source, ran the suite, and
measured the audio bank. Where this package says *measured*, it was computed —
not inferred.

---

## Read this first: four sources that will mislead you

Most of what you will reach for is accurate. These four are not, and each has
already cost someone a wrong turn.

**1. `MEMORY.md`'s one-line hooks.** Four contradict the file they link to
(avatar opacity/height, fused-bee spelling, persona timbre, startPadMs). The
linked files are fine. Open the file; never act on the hook.

**2. `tools/voice/README.md`, `docs/audio-validation-rulebook.md`,
`docs/audio-corpus.md`.** All three describe the per-punch phrase-clip pipeline
as the primary runtime path. It was **retired** in V2 Phase 5-iv (`369a2c6`).
`playCombination()` is a hardwired `return false`, the 776 wavs moved to
`assets/voice/phrases-legacy/`, and `phraseManifest.ts` was deleted. Rulebook
steps 3 and 4 cannot run — the tools they call now refuse with a message.
`callPlacement.ts`'s own doc comments are the real, mic-measured record.

`README.md` was on this list in error: it never mentions the pipeline. It is
stale on *status* instead — "planning complete", 30 milestones, dated
2026-08-22.

**3. The GitHub tracker lags the code.** 107 issues open across 18 milestones,
but the PR-per-change workflow was abandoned mid-September: the last 15 commits
on `main` went in directly with no PR. An open issue does **not** mean unbuilt
work. Two closed milestones (M07, M15) carry stale counters, and M46's
description cites a `tools/analysis/ledgers` directory that does not exist.

**4. Any constant you were told from memory.** Worked example: the brief that
produced this package asserted `LEAD_IN_PAD_MS = 282` in
`src/domain/coach/VoicePolicy.ts:41`. Every part was wrong — the value is
**250**, the file is **`src/domain/coach/callPlacement.ts:38`**, and
`src/domain/coach/VoicePolicy.ts` — which does exist — holds no such constant
(an earlier draft of this page said the file itself did not exist, which is the
mistake this paragraph warns about). 282 landed in `ea5df336` and was reverted in `1af8a232`
because the paired change caused cross-workout regressions. Grep before you
quote.

---

## The package

| File | What it is |
|---|---|
| `01-orientation.md` | Identity, current state, scope, what shipped |
| `02-architecture.md` | Subsystem map — where everything lives and how it connects |
| `03-coach-language-switching.md` | **Numbers vs strike names**, live switching, clip resolution, coverage (measured) |
| `04-beat-mapping-and-offsets.md` | **Beat→ms, every offset constant, anchors, acceptance windows**, how to measure |
| `05-toolchain-and-methods.md` | Stack, scripts, the real verification loop, tablet workflow |
| `06-review-targets.md` | Ranked adversarial-review targets, verified at HEAD |
| `07-new-workout-types.md` | Coupling inventory + sequenced roadmap for non-boxing disciplines |
| `_surveys.json` | Raw structured output from the seven survey agents |

Read `01` and `05` before touching anything. `03` and `04` are reference —
consult, don't memorize.

---

## Three things that decide how you work here

**The repo is dormant, not in-flight.** Last commit 2026-09-26; today is
2026-11-25. Nothing is half-finished in the working tree (it is clean). You are
starting a cycle, not resuming one.

**`.claude/` is gitignored** (`.gitignore:58`). Both in-repo skills —
`cadence-lab` and `qa-audio-verify` — hold the only written runbooks for the
verification loop, and `git ls-files .claude` returns **zero**. They exist only
on this machine. A fresh clone has no runbooks. Treat them as precious and
consider committing them.

**Metro's watcher is blind on `F:`.** Fast refresh never fires. A `(1 module)`
50 ms delta means you are testing **old code**. Restart Metro and cold-restart
the app after every edit batch. This single fact invalidates more on-device
conclusions than anything else in the project.

---

## Current scope

**In:** Velocity Lab (BLE engineering surface), punchCraft workouts (the boxing
cue/coach/scoring engine), and the work to extend it to non-boxing disciplines.

**Out:** the **Puncheoke instrument** — forked to its own product. Its code is
still physically present (`src/domain/instrument/` 29 files / ~6k lines,
`src/instrument/`, `src/app/(tabs)/puncheokie/`, `docs/puncheoke/`,
`tools/punchbridge/`) and it keeps the `puncheokie` identifiers on purpose:
expo-router matches the tab `name` to the on-disk directory, and the wordmark
key indexes an asset. **The boxing engine has zero dependencies on it** —
verified: the only hit in `domain/{workout,coach,timing,session}` is the word
"instruments" in a comment. Removing it is a clean excision whenever you want it.

---

## Naming, as of this package

"Puncheokie" was renamed to **punchCraft workouts** in prose; in code the brand
disappears and identifiers are `workout`/`workouts`. The GitHub repo is now
**`kyleruff1/punchCraft`**, the label is **`area:workouts`** (177 issues), and
log event codes moved `puncheokie.*` → `workout.*`.

Captures were deliberately **not** rewritten — 319 logcats and 173 run JSONs
under `tools/analysis/{sessions,suites,monitor,listen,batches}` still carry the
old prefix, because they are evidence from real drives and the regression
baselines are measured against them. `recordsWithTag` accepts both dialects;
`tools/analysis/__tests__/logcat-tag-aliases.test.js` pins it.
