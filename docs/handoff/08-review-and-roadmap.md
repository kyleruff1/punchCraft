# Cycle review + non-boxing roadmap

**Written 2026-11-25** by the incoming session, against
`review/handoff-cycle` = `6129f24b` (head of PR #390 = `main 8b7e79a2` + the
rename + `docs/handoff/`). Nothing in the working tree was modified to produce
this document.

Method: 21 agents in two adversarial passes — four re-deriving the 18 targets in
`06-review-targets.md`, three fresh hunts each checked by an independent
skeptic, nine adjudicators re-testing the survivors for *reachability on shipped
content* and *what Kyle would actually observe*, one completeness critic, one
roadmap verifier. Every claim below was then checked against the source by hand.
Where this document says a line number, it was read at `6129f24b`.

**Measured baseline:** 181 suites / **4148 tests** / 22 snapshots green, 142 s;
`tsc --noEmit` exit 0; `guard:playlist-sample-rate` exit 0;
`guard:velocity-terminology` **exit 1** (see T-2).

> **Status at the end of 2026-11-25.** Everything in §2 and §3 marked HIGH or
> MEDIUM is now fixed and committed on `review/handoff-cycle` — one commit
> per fix, nothing pushed. Each finding below carries a "Status"
> note saying what was done and what is still unverified.
>
> | | Commit |
> |---|---|
> | H-1 clock domains | `a360b4e8` |
> | H-3 shared BLE monitor | `4da51af0` |
> | H-2 Android back | `e5184e05` |
> | H-4 duration keeps intensity | `e9749377` |
> | P-2 guard allowlist | `dd3a75f0` |
> | N-1 deduplicated punch | `7de47b95` |
> | T-1 jest in a worktree | `525d191e` |
> | T-2 click-path gates | `a1986900` |
> | fake clock origin | `745894ef` |
> | H-4 root cause (round filler) | `7be9d2ed` |
> | M-1 / M-4 paused and post-stop punches | `b068fd29` |
> | M-2 coach off | `16417f3a` |
> | M-6 mid-rest vocabulary flip | `32b65fa9` |
> | M-5 repeated cue | `65946d40` |
> | M-3 Discard | `0663a33e` |
>
> **Three of this document's own write-ups were wrong** in ways that changed
> the work, and are corrected in place: the **H-3 fix** (the "3 lines" would
> not have fixed it), the **H-4 root cause** (not the repair cap), and
> **T-2** (the gates I said were suppressed could never fire at all; the real
> gaps were elsewhere). A fourth claim is simply false: `tools/analysis/` does
> have tests.
>
> **Verified at this state:** 186 suites / 4,428 tests / 22 snapshots green
> with a bare `npx jest`; `tsc` and `eslint` clean; both guards pass.
> **Not verified:** anything on the tablet, and the QA suite has not been
> re-driven since its verdicts were tightened. The checklist is §7.

> **Second batch, later on 2026-11-25** — branch `review/handoff-cycle-2`, cut
> from the head of PR 391, one commit per fix, nothing pushed. What each item
> became, and what the batch turned up on its own, is in **§3b**.
>
> | | Commit |
> |---|---|
> | QA link can no longer grant itself QA mode | `f9f758ee` |
> | `voiceMode` split: authored `coachPath` | `308540cf` |
> | Sprint rounds fill to the bell (generator 1.3.1) | `8538aa40` |
> | Repeat placed only where it can run | `1d0e33af` |
> | Velocity Lab Live no longer re-initialises a glove | `8730db02` |
> | Handoff package errata + H13 (bonding) | `bbfd5c4c` |
> | Runbooks tracked | `e886924b` |
> | **Found here:** migration 003 restored to its shipped SQL | `e9615f77` |
> | Upgrade-path tests + append-only guard | `fa4f3291` |
> | Saved voice settings validated | `1d7ecdee` |
>
> **Verified at this state:** 190 suites / 4,527 tests / 22 snapshots green;
> `tsc` and `eslint` clean; both guards pass. All 22 compiled timeline hashes
> and token-stream snapshots are unchanged. **Still not verified:** anything
> on the tablet. §7 has the additions.


---

## 0. The short version

The engine is in better shape than 107 open issues suggest, and the handoff
package is a genuinely good artifact — its code citations held up almost
everywhere I checked them. But three things change how I'd spend this cycle:

1. **A single clock-domain error is live on every punch of every session.** It
   corrupts `cue_results.offset_ms` in every row ever written, forces
   `timingWindowPct` to 0, and silently kills the on-beat reward haptic. The
   test suite cannot see it because the fixtures derive event time *from* cue
   time, and 58 of 76 `createFakeClock` call sites use origin 0, where the two
   clock domains are numerically the same number line.
2. **The verification loop cannot hard-fail on the 22 workouts it verifies.**
   `assetMissing`, `deferred` and `notArmed` are suppressed to warnings for
   every one of them, permanently, because of a stale assumption in
   `verify-first-round.mjs`. Until that is fixed, "the suite is green" and the
   LOOP ledger's WARNs are not interpretable — and several of the package's
   "measured" claims rest on them.
3. **The roadmap's central finding is correct**, and the scoring path really is
   discipline-neutral. But the roadmap defers two costs that get *more*
   expensive with every workout shipped, and they are one-line changes today.

So: fix the instruments first, then the findings. Details and the proposed order
are in §6.

---

## 1. What's wrong with the handoff package

You asked specifically. Most of it is right; these are the parts that will cost
the next session.

### P-1 · The showcase lesson fails its own test

`00-START-HERE.md:35-37` offers one worked example of "grep before you quote,"
and asserts: *"there is no `VoicePolicy.ts` at all."*

`src/domain/coach/VoicePolicy.ts` exists — 5,614 bytes, tracked at `main`
(`blob bd248f69`), the V2 three-axis interface. Docs `03`, `04` and `07` of the
same package describe it correctly. The true claim, which `04:7` and `07:335`
both state properly, is that there is no such *constant* in it. Only the
headline paragraph overreached from "no such constant" to "no such file."

The value of the lesson survives; the example needs the one-word fix.

**Status: done** (`bbfd5c4c`).

### P-2 · PR #390 is red, on the guard the package documents

`guard:velocity-terminology` exits 1 with 4 violations. All four are in
`docs/handoff/05-toolchain-and-methods.md:36-37` — the lines that *describe the
guard's banned list*:

```
velocity-terminology guard: 4 violation(s)
  docs/handoff/05-toolchain-and-methods.md:36  banned literal (the two-word phrase the list opens with)
  docs/handoff/05-toolchain-and-methods.md:37  token `force` used near a velocity reference
  docs/handoff/05-toolchain-and-methods.md:37  token `power` used near a velocity reference
  docs/handoff/05-toolchain-and-methods.md:37  token `energy` used near a velocity reference
```

(First line paraphrased: quoting it here made this document the guard's fifth
violation.) Confirmed locally and on CI (`gh run 45567993656`). Line 36 asserts "both guards
clean" immediately above the text that breaks one. `01-orientation.md` also
reports "Open PRs: **Zero**" — PR #390 was opened at 07:25 that same day by the
session that wrote the sentence.

**Fix with in-repo precedent.** `FILE_ALLOWLIST`
(`tools/guards/velocity-terminology.mjs:33-45`) already exempts
`docs/protocol/hypotheses.md` ("the terminology rule applies to app-facing
labels, not to reference-doc quotations") and
`samples/__tests__/samples.test.ts` ("Flagging the rule's own explanation is the
scanner reading prose"). The second rationale is this case exactly. Add
`docs/handoff/05-toolchain-and-methods.md` with a comment in the same register.
Rephrasing is the wrong fix — it would mean the doc cannot name the banned
tokens.

**Status: done** (`dd3a75f0`). The one file is allowlisted with a comment; the
guard is green, which also unblocks PR #390's CI.

### P-3 · `README.md` is misfiled as stale

`00-START-HERE.md:27-33` and `01-orientation.md` tell you to distrust
`README.md` for describing the retired per-punch phrase pipeline as the primary
runtime path. `README.md` is 64 lines and contains **zero** occurrences of
"phrase"; its only voice-related line is *"an optional Voice Coach"*
(`README.md:13`).

It *is* stale — it still says "Puncheokie" at `main`, and that is worth fixing —
but a session told to distrust the wrong part will trust the wrong part. The
other three are correctly flagged: `tools/voice/README.md` (12 "phrase" hits),
`docs/audio-validation-rulebook.md` (26), `docs/audio-corpus.md` (19).

**Status: done** (`bbfd5c4c`) in `00`, `01` and `CLAUDE.md`, which repeated it.
The README's milestones link, which the rename had turned into a URL with a
space in it, is repaired in the same commit. Its status line ("planning
complete", 30 milestones) is still stale and still says so.

### P-4 · "The score path never runs on shipped content" is false

`02-architecture.md` states the SlotDispatcher V2 coach path "never runs on
shipped content," and asks a future session to internalize it before debugging
audio. `07-new-workout-types.md:§9 item 10` separately says `'exact-combo'` is a
`BlockKind` nothing ever emits.

`diagnostic-token-sequence` is a shipped sample. It spreads `defaultRecipe()`
(`diagnosticTokenSequence.ts:106`) **without overriding `voiceMode`**, so it
inherits `'standard'` (`WorkoutRecipe.ts:209`) and
`scoreDispatchEnabled = workout.recipe.voiceMode !== 'minimal'`
(`_useWorkoutRunner.ts:1759`) is **true** there — as it is for any generated
workout at default settings. It also emits `'exact-combo'` four times
(`diagnosticTokenSequence.ts:53,54,55,57`).

This matters beyond pedantry: it raises the severity of anything on the score
path (notably package target 3, the unguarded 50 ms tick), and it is why the
provenance handshake in T-2 below is dead on exactly the 22 workouts that *are*
driven.

**Status: done** (`bbfd5c4c`), and the ground under it moved (`308540cf`): the
marker is no longer `recipe.voiceMode`. A workout says which path it is on with
an authored `coachPath`, read through `coachPathOf`. `02-architecture.md` now
says both things.

### P-5 · Six citations point at a file this same PR deleted

`07-new-workout-types.md` cites `docs/puncheokie-ux-workout-engine.md` (:23,
:557, :1069, :1104) — including for **D13**, the acceleration transmit floor,
the single hardest hardware constraint in the project. Commit `bd2ca682` renamed
it to `docs/workouts-ux-engine.md` and correctly updated `CLAUDE.md:3`. The line
numbers all still land; only the path is dead.

**Status: done** (`bbfd5c4c`) — five occurrences, in `03` and `07`.

### P-6 · The only runbooks are ungitted *and* stale

`git ls-files .claude` → 0, confirmed. Both runbooks total 317 lines / 24 KB
across two `SKILL.md` files plus one report template — trivially committable.
They are also stale in the same way the package warns about:
`cadence-lab/SKILL.md:27` cites `_useWorkoutRunner.ts:556-558` for the stubbed
cadence rail; the real lines are **:477-478** and **:1719** (the package has
this right). It also references `tools/analysis/reports/cadence-audit.json`,
which does not exist.

**Status: done** (`e886924b`). `.gitignore` ignores everything under `.claude/`
except `skills/`. Corrected on the way in: every log code in both runbooks
still carried the pre-rename `puncheokie.` prefix (the app logs `workout.*` —
being untracked is how they missed the rename); `file:line` references became
symbol references; the QA runbook's `qa=1` step became the Settings switch.
Left as it was and marked stale in the file: cadence-lab's clip-fixing
section, which describes the retired phrase pipeline, and the report
template's `cadence-audit.json` path. Nothing in either runbook is new to the
repo, which is public: no credentials, and the local tool paths and tablet
notes already appear in tracked files.

### Verified correct, no correction needed

`LEAD_IN_PAD_MS = 250` at `callPlacement.ts:38`. The `ExpectedPunch` shape.
`CueMatcher`'s technique short-circuit. Exactly 12 `.number`/`.body` read sites
under `src/domain/programs/`. `resolveHand` and `strikeFor` with one production
caller each. Target line numbers hold exactly — the rename was line-for-line
(15 changed lines in the runner, no shift).

One suspicion of mine that did **not** survive: I thought the package's
`(tabs)/punchcraft/` citations were invalid at `8b7e79a2`. They are valid — that
directory already existed at `main`; the rename changed identifiers, not
directories.

---

## 2. The two tooling defects that gate everything else

### T-1 · `jest` finds zero tests from inside a worktree · **fix first, 1 token**

`jest.config.js:23-34` `testPathIgnorePatterns` contains the unanchored
`'/.claude/worktrees/'`. Run from `F:\punchCraft` that is correct and
deliberate — it stops jest discovering sibling agent worktrees and reporting a
combined count. Run from *inside* one, it matches the worktree's own absolute
path and ignores **every** suite:

```
No tests found, exiting with code 1
  661 files checked.
  testPathIgnorePatterns: …, \.claude\worktrees\, … - 0 matches
```

`modulePathIgnorePatterns` on the very next line (`:35`) is already written
correctly as `'<rootDir>/.claude/worktrees/'`.

**Fix:** `'/.claude/worktrees/'` → `'<rootDir>/.claude/worktrees/'`.

**Status: done** (`525d191e`). A bare `npx jest` from this worktree now finds
and runs every suite. Checked the other direction too, against the pattern
jest builds when `rootDir` is `F:\punchCraft`: it still ignores a nested
worktree's tests and keeps its own.

The package could not have found this — it ran from `F:\punchCraft`. But any
Claude Code session defaults to a worktree, so the "baseline gate" instruction in
`07:§0` silently reports success-looking failure to every future session. Worth
noting the package's own gate command has a second, milder version of the same
bug on Windows: `/__tests__/helpers/` uses forward slashes and never matches
backslash paths, so it reports "2 failed suites" that are just helper files.

### T-2 · The verifier cannot hard-fail on any of the 22 workouts it verifies · **HIGH**

> **Correction — the mechanism below is wrong, and so was the fix.** The
> headline overstated it too: the verifier *could* already fail a shipped
> sample, on a missing or duplicated lead-in.
>
> The three gates are not merely suppressed on the 22 click-path workouts;
> they are **inert**. `notArmed` needs a `combo-announce` in the manifest, and
> none of the 44 manifests has one — every coach event in them is a `lead-in`.
> `deferred` and `assetMissing` are counted from `slotDispatcher.*` records
> that only the score path writes, and those workouts do not run it. Flipping
> the suppression polarity, as proposed at the end of this section, would
> have changed no verdict at all.
>
> What the verifier genuinely did not check on the click path:
>
> - **Per-bar loop calls** — about seventy a round, most of what the coach
>   says. `callsDispatched / expectedCallBars` was printed, with "LOW" under
>   90%, and never touched the verdict.
> - **Playback failures.** `voice.playFailed` and `voice.clipMissing` were
>   parsed and then dropped.
> - **Identity.** Nothing tied a capture to its manifest's workout or
>   timeline — this part of the original text stands.
>
> **Status: fixed** (`a1986900`), **pending one suite drive.** The runner logs
> `workout.timeline.provenance` for every workout; on the click path it
> compiles the score for its hash only when `__DEV__ || isQaEnabled()`, inside
> a `try`. The verifier reads that record (falling back to
> `slotDispatcher.armed`), checks the workout against `runner.start`, treats
> an unverified capture as WARN rather than PASS, FAILs on a clip that did
> not load or play inside the round, FAILs when no loop call was dispatched
> where some were expected, and WARNs under the existing 90% line.
> `provenance.test.tsx` checks, for all 22 samples, that the hash the runner
> logs is the hash the checked-in manifest carries — so the first drive
> should not read STALE across the board, but only a drive can say.

*(Original text, kept for the record:)* This one undermines the evidentiary
base of the whole project, including parts of the handoff package.

`verify-first-round.mjs:576` suppresses three gates when provenance is not
provable:

```js
const gateSuppressed = stale || identityUnknown
const newGates = deferred > 0 || assetMissing > 0 || notArmed
const hardFail = !t0 || provenance.workoutMismatch || missing > 0 || duplicated > 0 ||
  (!gateSuppressed && newGates)
const softWarn = … || (gateSuppressed && newGates)
```

`identityUnknown` is `provenance.state === 'unavailable'`, which
`checkProvenance` (`:306-310`) returns when the capture holds no
`slotDispatcher.armed` record.

That record is logged at `_useWorkoutRunner.ts:1902-1912`, inside
`if (announcer && voice && scoreDispatchEnabled)` (`:1774`). For all 22 drivable
workouts `voiceMode` is `'minimal'`, so `scoreDispatchEnabled` is false and the
record is **never emitted**. `ls tools/analysis/manifests/` is exactly 44 files
= those 22 × 2 vocabularies, with **no** `diagnostic-token-sequence` manifest —
so the provenance check is alive only on the one workout the suite never drives,
and dead on all 22 it does.

Net effect: for every run Kyle has ever judged, a **missing coach asset**, a
**deferred call** and a **dispatcher that never armed** can only ever produce a
WARN. They cannot fail.

**Named root cause.** `checkProvenance`'s own docstring (`:300-305`) says the
armed log "sits inside `if (announcer && voice)` with no slot-count guard, so
even a zero-slot workout carries a hash." That was true once. The condition
gained `&& scoreDispatchEnabled`, and the comment — and the `gateSuppressed`
logic built on it — were never revisited. The suppression is reasonable for the
rare case its author had in mind (coach off, truncated capture); it is wrong as
the permanent state of the content under test.

**Fix, two parts.** Move the timeline-hash log out of the score-path branch so
every workout emits provenance; then invert the polarity at `:576` so absent
provenance escalates rather than relaxes. Both are desk changes; the second
needs one clean drive to re-baseline the ledger.

---

## 3. Confirmed findings, ranked

All nine adjudicated findings came back `CONFIRMED_NARROWER` — the mechanisms
held, the severities and the stated root causes often did not. Severity below is
my own, after reading each one.

### H-1 · One clock-domain error, three places, live on every punch · **HIGH**

`MonotonicClock.now()` is documented as *"Milliseconds from an arbitrary
origin"* (`src/domain/time/MonotonicClock.ts:25-26`) and implemented as
`performance.now()` — app uptime. Both the real BLE path
(`BleManagerBlePlxImpl.ts:222`, `:541`) and the simulator
(`SimulatedPunchSource.ts:252`) stamp `receivedMonotonicTimeMs` from it, and the
runner hands the raw event straight to the matcher
(`_useWorkoutRunner.ts:1241`).

`cue.scheduledStartMs` is `block.startOffsetMs + repeatIndex * (comboSpanMs +
gapMs)` (`CueTimeline.ts:380`) — round-relative work-elapsed, origin at the
round start.

`CueMatcher.ts:173` subtracts one from the other:

```js
offsetMs: atMs - this.scheduledMomentMs(cue, expected),
```

The two bases differ by the app's uptime at round start — unbounded,
session-specific, typically tens of seconds to hours. Three consequences:

- **`cue_results.offset_ms` is garbage in every row ever written**
  (`cueResultRows.ts:71` → `004_workouts.ts:163` / `005:63`). Migration 005's own
  comment calls the column *"Event time minus window open, on the monotonic
  clock"* — the schema documents the mixed-domain subtraction.
- **`timingWindowPct` is always 0.** `cueScoring.ts:125` counts assignments with
  `Math.abs(a.offsetMs) <= TIMING_TIGHT_MS` (150 ms); none ever qualify.
- **The on-beat reward haptic never fires.** `onTimeForMatch`
  (`_useWorkoutRunner.ts:243-251`) repeats the same subtraction, and its
  docstring says it *"Mirrors the matcher's own timing math"* — accurately. So
  `hapticsRef.current?.strike('good'|'perfect')` at `:1308` is dead code in
  practice. This is the one user-visible part: a shipped feature that is
  silently absent.

Honest severity: HIGH on correctness and on the permanent record, MEDIUM on
observable product impact, since neither `offsetMs` nor `timingWindowPct` is
rendered anywhere (`summary.tsx` and `src/components/workout/*` have no
reference to either).

A fourth manifestation is the one the package found as target 6: for a
`recovered` event, `eventTimeMs` returns `trackerTimestampMs`, which is **epoch
milliseconds** (`FightCampV1Decoder.ts:241-243` builds it as
`epochSeconds * 1000 + …`) — a *third* domain, ~1.79e12. Under the default
`gate: 'window'` that value fails the window test and lands harmlessly in
`extras`; but `LiveCueMatcher.ts:344` calls the settled pass with
`gate: 'open'`, which **skips that test**, and `:209` buffers every event into
`open.events` *before* the `if (event.recovered) return` at `:233`. So the
recovered-event exclusion covers provisional placement only. A buffer drain
mid-round lets a punch thrown 22–66 s earlier consume the next unfilled slot.
The package's "feeds recovered events into the authoritative pass" is right; the
`gate: 'open'` skip is the mechanism that makes it bite, and `gate: 'window'`
has **zero** production callers.

**Why 4148 tests pass.** The fixtures derive the input clock from the expected
output's clock. `CueMatcher.test.ts:41` is
`receivedMonotonicTimeMs: CUE.scheduledStartMs`, and `:58` is
`CUE.scheduledStartMs + (CUE.tokenOffsetsMs[expected.tokenIndex] ?? 0)`, with
~30 further `CUE.scheduledStartMs ± n` variants through `:378`. So `offsetMs` is
tested as `(base + d) - base == d` — an algebraic identity true for *any* base.
The only quantity that is wrong in production is cancelled out before the
assertion runs. The suite does not merely miss this bug; **it asserts the broken
assumption**.

Reinforcing it repo-wide: `createFakeClock(startMs = 0)`
(`src/testing/fakeClock.ts:30`), and **58 of 76** call sites take the default.
At origin 0, app-uptime and round-relative work-elapsed are the same number
line. The irony is that
`src/domain/programs/__tests__/helpers/fakeClock.ts:12-20` documents keeping
`workElapsedMs` and the monotonic clock *"deliberately separate"* — which has no
numeric consequence at origin 0.

**The cheap lever.** Change `createFakeClock`'s default origin from `0` to a
large constant and run the suite. That one edit converts this entire defect
class from "spotted by a careful reader" into a mechanical failure list — it
will surface `CueMatcher.ts:173`, `onTimeForMatch`, `CueTimestamps` and anything
not yet found, plus every fixture that cheats. Do this **before** fixing
`offsetMs`, so the fix is provable.

**Status: fixed.** One conversion, in one place. `WorkoutSessionClock.workElapsedAt`
places a monotonic instant on the work clock (the same accumulated-with-holes
projection `SharedWorkClock` uses for the ring, pinned to it by a test).
`CueMatcher.match` now takes `PlacedPunch` — an event plus its work-elapsed time,
or `null` if it cannot be placed — and reads no time off the event; the
function that returned uptime for live events and device epoch for recovered
ones is gone. `LiveCueMatcher.onPunchEvent` takes the work-clock time as a
required argument and reports `offsetMs` on every live match, so the runner's
duplicate subtraction (`onTimeForMatch`) is deleted and the haptic gates on the
matcher's own number. `CALCULATION_VERSION` is `1.1.0`; every `1.0.0`
`offset_ms` is meaningless and cannot be recalculated (the anchor was never
stored).

- **Recovered events are no longer credited to a cue.** They are buffered as
  unplaceable and settle as extras — which is what the decoder's own comment
  (`FightCampV1Decoder.ts:155-162`) says should happen.
- **The on-beat haptic now fires.** It never has on the bag; that is a new
  feel, and worth a deliberate listen.
- The fixtures in the four matcher suites now stamp punches an hour of
  "uptime" away from their work-clock time, so the identity that hid this can
  no longer cancel. A new runner-level suite (`clockOrigin.test.tsx`) drives the
  real runner into real SQLite at four clock origins and requires identical
  rows. Mutation-checked: restoring the old behaviour makes it fail by exactly
  5 080 ms at origin 0 (the countdown) and 3 605 080 ms at one hour.
- **The global `createFakeClock` default has since been flipped** (`745894ef`)
  to a named, non-round constant. It surfaced 12 failures in three suites
  (`rhythmMapParity`, `silenceRepro`, `SimulatedPunchSource`), every one a
  fixture reading a monotonic stamp as round time, and no further product
  defect. One thing it could not see and I noticed reading:
  `SimulatedPunchSource.ts:259` stamps `trackerTimestampMs` with the monotonic
  receive time — a simulated event's "device epoch" field holds app uptime.
  Harmless today (sim events are never `recovered`), but it is the same
  confusion in miniature.

### H-2 · Android hardware back silently discards the whole workout · **HIGH**

The one unguarded exit from a live workout. Stop (`live.tsx:982-984`) and Exit
(`:1055-1056`) both run `emergencyStop()` → `cancel()` → `endSession(true)` and
write the session. The tab bar is *not* an exit — `live.tsx:677-678` sets
`display: 'none'` for the screen's whole focused lifetime. But Android back pops
the route, the runner's cleanup is deliberately passive
(`_useWorkoutRunner.ts:2168-2192`) and never calls `endSession`, and nothing
intercepts the event. `_layout.tsx:25` sets `headerShown: false`, so the screen
draws no back chrome to discourage it.

Symptom: the athlete lands back in the lobby, the workout is gone, no summary,
nothing logged as lost — `endSession`'s own failure logger (`:1424`) never runs
because `endSession` is never entered. Observable and unrecoverable.

**Fix** belongs in the screen, not the cleanup (which is correctly passive):
register a hardware-back guard in the existing `useFocusEffect`
(`live.tsx:668-697`) that, while `isWorkoutActive(live.phase)` — a predicate
that already exists and is exhaustively tested (`_audioHold.ts:47-49`) —
swallows the event and runs the Exit path.

**Status: fixed, as described.** The Exit button and the back handler share one
`stopForExit` callback; the phase is read from the store at press time, so a
handler registered while idle still acts correctly mid-round. Back during
countdown / work / rest / paused stops the workout (saved as cancelled) and
shows the existing dialog; a second press leaves. Not yet checked on the
tablet. The gentler alternative — first back pauses, second stops — was
considered and not built; with gloves on, an accidental edge swipe now costs
the rest of the workout rather than the whole record of it.

### H-3 · A stale BLE subscription handle tears down the live one · **HIGH**

`BleManagerBlePlxImpl.monitorSubs` keys one slot per
`(device, service, characteristic)` with **no ownership token**.
`monitorCharacteristic` evicts any incumbent on the same key with a bare
`/* ignore */` (`:523`), and *every* handle's `unsubscribe()` deletes whoever
currently holds the key — not necessarily its own subscription.

Symptom: total, silent loss of punch detection for the rest of the app session
with every indicator still green. Both header lamps stay lit and battery keeps
updating (the keepalive uses `writeCharacteristic`/`readCharacteristic`, not
notifications); the live screen never falls back to the simulator
(`useLivePunchSource` latches its choice and only upgrades sim→tracker);
`initErrors` is empty because the keepalive's init plan *succeeded*; and no log
line is emitted. You walk onto the bag and the workout counts zero punches with
nothing to diagnose.

The adjudicator corrected the trigger: "disconnect, reconnect, re-arm" is
**safe** on a single owner (`PunchStream.stop()` tears down synchronously at
`PunchStream.ts:248-250`, and auto-reconnect is 5 s later —
`RETRY_DELAY_MS = 5_000`, `autoConnectTrackers.ts:324`). It needs **two owners**
on one key — reachable without any race via the shipped Velocity Lab screens
against the always-on keepalive.

**~~Fix (3 lines, safe without hardware)~~ — this was wrong.** I proposed an
ownership check on `unsubscribe()`. Re-reading the callers before writing it
showed two triggers, and that check closes only the rarer one:

- **Trigger X — deterministic, no race, and the one that matters.** Gloves
  connected, open **Velocity Lab → Live** (`velocity-lab/live.tsx:317`, its own
  `startPunchStream` per glove) or **Probe** (`probe.tsx:276`,
  `monitorAllNotifiable`). Each subscribes on a key the app-wide keepalive
  already holds, and the old `monitorCharacteristic` **evicted the keepalive's
  native subscription at subscribe time**. The keepalive still believes it is
  armed — `TrackerPunchEventSource.arm` only re-runs on a connection
  transition — so every later workout counts zero punches until a glove
  happens to reconnect. An ownership check on *unsubscribe* does nothing: the
  incumbent was killed by the newcomer's *subscribe*.
- **Trigger Y — the one written up above.** A handle left over from before a
  reconnect unsubscribes and removes whoever holds the key now.

`trackerKeepalive.ts:17-23` already states the invariant — "one stream per
device, ever" — and `useLivePunchSource` honours it for the workout screen.
Velocity Lab was never brought under it.

**Status: fixed in the transport, pending the tablet.** One native monitor per
characteristic, many listeners. A second subscriber on the current connection
*joins*; each handle removes only its own listener; the native monitor goes
with its last listener; a frame reaches the sink once however many are
listening. A monitor from an earlier connection generation, or one whose
callback has reported an error, is replaced rather than joined — the one case
the old eviction was right about. Every registry mutation is by entry identity,
so a late "operation cancelled" from a replaced monitor cannot unregister its
successor. `BleManagerBlePlxImpl.monitor.test.ts` is the first test this class
has had (25 cases, 15 of which fail against the original code, including both
triggers).

**What jest cannot show** is how the real stack behaves. The check on the
tablet: gloves connected → Velocity Lab → Live → back → start a workout →
punches count. Not fixed, and noted in passing: Velocity Lab Live still
re-runs the init plan on a glove the keepalive already initialised.

### H-4 · A one-tap Duration change leaves ~50 s of silent coach in every round · **HIGH**

The duration picker (`recipe.tsx:190-195`) carries the stale `totalPunchGoal`
across a duration change. At a goal/round ratio of roughly ≤113, the 7-phase
fill leaves the blocks exhausted before the bell.

**Root cause, corrected.** Not the repair cap, which I named first. In
`roundFill.ts` `addRepeatPhase` (`:412-419`) a low per-round target gives few
reps; the solved gap then exceeds its 5-beat ceiling and is clamped; and
`Math.min(reps, fitReps)` keeps the *small* rep count, so the phase spans a
fraction of its time share. The comment two lines above says "honour the TIME
budget over the punch share" — the code does that only when the gap clamps at
its *lower* bound. `MAX_REPAIR_PASSES = 24` is merely what fails to cover the
hole. Proven by mutation: using `fitReps` when the solved gap exceeds the
ceiling takes 60 min @ 900 from 605 s of free work to 11 s, and fills every
low-goal case tried.

The round does **not** end early — that part of the original finding was wrong,
and the distinction matters for diagnosis. The clock and bell are untouched; the
*coach* goes silent. `CueEngine.ts:261-266` returns
`{ status: 'gap', remainingMs: 0, freeWork: true }` and `live.tsx:867` swaps the
cue stage for `idleLabel: 'Free work — keep your hands moving'`.

Measured for 20 min → 60 min with goal 900, mirroring `live.tsx`'s own clip
gates: all 12 scored rounds affected, free-work tails of 41.6, 43.2, 44.3, 47.8,
49.3, 50.0, 46.1, 50.7, 59.8, 61.3, 62.1, 41.4 s — **597.6 s of 2880 s, 21% of a
48-minute work block** on a dead screen. Duration-dependent, not universal.

Compounding it: `generateWorkout.ts:175-179` already *diagnoses* this via
`coverageAudit` and the warning is stored but never surfaced.

**Fix, three separable pieces** — the first two from the desk, the third needs
your ear: (1) carry the athlete's chosen *intensity* across a duration change
and re-derive the goal from `GOAL_TIERS`; (2) surface the coverage warning in
the recipe screen; (3) revisit the repair cap, which is a tuning question.

**Status: (1) and (2) done; (3) deliberately not.**

- **(1)** The Duration picker now rescales the goal in proportion
  (`rescaleGoalForDuration`). Every `GOAL_TIERS` row is exactly linear in
  minutes, so this keeps the tier and also any stepper fine-tune or focus
  scaling — which snapping to the tier's cell would discard. Default 900 @ 20
  becomes 2,700 @ 60. Re-measured with the live screen's own options: 20 → 60
  at the kept goal is **605 s of 2,880 s** free work, all twelve rounds; at the
  rescaled goal, **13.5 s**.
- **(2)** The recipe screen generates the workout it would run — with the same
  options the live screen uses, now one shared builder
  (`src/audio/fillOptionsForRecipe.ts`) — and shows a warning on the goal row
  and in the summary when rounds would run dry (`coverageConflict`). A low goal
  set with the stepper still produces silent tails; the athlete is now told
  before starting rather than finding out on the bag.
- **(3)** ~~The generator is untouched.~~ **Fixed at Kyle's direction**
  (`7be9d2ed`): when a phase's gap hits its ceiling the reps now come from the
  time budget. `GENERATOR_VERSION` is `1.3.0` — and since the version seeds
  selection, **every** generated workout differs from its 1.2.0 plan for the
  same seed, not only low-goal ones. Of 1,152 sampled cells (4 durations × 12
  goals × 4 cadences × 3 seeds × 2 option sets), **775 failed the coverage
  audit before and 8 do now**. `roundFill.test.ts` holds D26 at every goal
  from 50 upward for three cadences; the old suite sampled only the default.
  - **The 8 that remain are the real repair cap.** All sprint cadence, around
    250 punches a round, 5–7 s short. At that tempo one repair pass adds under
    a second and the loop is bounded by count (24 two-rep passes, then 6
    single reps), not by time. Pinned in a test, not changed — re-bounding it
    changes how a round ends. **Since fixed** (`8538aa40`, generator 1.3.1):
    both loops are bounded by progress, and sprint is in the any-goal sweep.
  - **The warning from (2) is re-aimed.** A low goal no longer runs a round
    dry, so "raise the goal" would be advice that changes nothing. What still
    does is too narrow a content pool — one enabled punch, or combinations
    capped at one or two, leaves 12–29 s tails. `coverageConflict` now fires at
    10 s rather than the audit's 5 s, points at those two controls, and says
    to enable more punches. **The cause was misattributed here.** It is not
    the narrow pool as such: the same-move announcement pass drops a whole
    trailing block to pay for a 6-7 s call and nothing refills the round. See
    N-3 in §3b — it also hits a cap of 2 with every punch enabled.
  - Still wants your ear: how a low-goal round sounds now that it is full.

### M-group · Six confirmed MEDIUMs

| # | Finding | Observable? |
|---|---|---|
| M-1 | **Punches thrown while PAUSED are fully credited.** `onPunch` (`_useWorkoutRunner.ts:1187-1242`) has no phase input: counts, `freezeRef.observePunch`, pacing, haptics and `matcherRef.onPunchEvent` all run. `CueEngine.tick` has the right guard at `:177`; `notifyMatch` (`:188-192`) does not. The "Paused" overlay covers only the stage (`live.tsx:876-880`), so the counters visibly climb beneath it. Credit requires a cue window open at the moment of the pause; the completion and reward haptic materialize on *resume*. The saved record cannot distinguish these punches afterwards. | Yes — counters move, tablet buzzes, record is wrong |
| M-2 | **"Voice coach: Off" still rings the round bell** on all 22 samples. `_useWorkoutRunner.ts:1689` caps the policy at `'minimal'` by *overwrite* rather than *floor*, so `mode: 'off'` becomes `'minimal'`. Narrowed hard: **only** the bell, 3–4 dings per sample at full `bells` volume; not one word is spoken. Fix is one clause — make it a floor. | Yes |
| M-3 | **The post-Stop "Keep this session?" dialog is a no-op.** Save and Discard are two separate inline handlers with byte-identical behaviour (dismiss + `router.back()`), and the row is committed before the dialog renders. Root cause is not persistence ordering — writing on cancel is deliberate and tested (`persistOnEnd.test.tsx:333-349`) — it is that the screen offers a choice that exists nowhere below it: `WorkoutRunner` exposes no discard and `SESSION_STATUSES` (`003_sessions.ts:88-98`) has no `'discarded'`. | Dialog only; no reader yet |
| M-4 | **Post-terminal counter creep.** `emergencyStop`'s `source.stop()` is a no-op on the real-tracker path, and `onPunch` has no terminal-phase gate, so counters climb under the "Stopped"/"Workout complete" overlay. Two-line fix in the runner, source-agnostic — it also covers the natural-finish window `source.stop()` never addressed. | Yes |
| M-5 | **`repeatCue()` reps are never written to `cue_results`.** The injected cue lives only in `CueEngine.runtimes` with a synthetic id, while every consumer is keyed off the static timeline (`cuesById`, `_useWorkoutRunner.ts:1328`). Nothing is overwritten — the row simply never reaches persistence. Latent and worse: `source.repeatIndex + 1` duplicates the *next natural* rep's key on every shipped block. | No; silent record loss |
| M-6 | **A mid-rest vocabulary flip kills the rest script.** Root cause is *not* the unreset `started` latch named in the original finding: `prepare()` accepts a scriptId swap while a playlist is in flight, and `CeremonyPlaylist.build()` unconditionally disposes the sounding playlist (`CeremonyPlaylist.ts:122`) before the latch (`RecoveryPlayer.ts:97-98`) blocks the replacement from ever starting. The voice stops mid-word — cleanly, since teardown pauses before destroying — and the rest of the rest head is silent. | Yes — your ear would catch it |

**Status: all six fixed.**

| # | Commit | What changed | Left open |
|---|---|---|---|
| M-1, M-4 | `b068fd29` | `onPunch` returns early while the session is `paused`, `completed` or `cancelled`: nothing counts, matches or buzzes. | Punches before the first bell and through a rest still count, as before. |
| M-2 | `16417f3a` | The recipe's minimal cap is a ceiling; `'off'` survives it. | — |
| M-6 | `32b65fa9` | `RecoveryPlayer.prepare` ignores a different script once the walkthrough has started. | The new vocabulary applies from the next rest, not mid-rest. |
| M-5 | `65946d40` | `cue-settled` carries its cue, so a repeated rep's rows are written; the copy takes the next free repeat index. Mutation-checked: with the old index the session write fails on the primary key. | A repeated cue still has no entry in the spine or walk plan. Repeating any rep but a block's last also makes it start on top of the natural next rep, and the engine closes one of them at once — unexamined. |
| M-3 | `0663a33e` | `WorkoutRunner.discardSession()` deletes the session the run wrote; Discard calls it, Save just leaves. | The `generated_workouts` row is left (its id is shared across sessions of the same workout). |

### Package target re-verdicts

Of the 18, I'd flag these as needing correction before anyone acts on them:

| Target | Package | Verdict | The correction that matters |
|---|---|---|---|
| 1 (coach gate) | HIGH | **OVERSTATED** → MEDIUM | The blast radius fails for the obvious fix. `voice.policy.mode` is the **store** recipe's `voiceMode` (`live.tsx:132-135`, `recipe = useRecipe()`), *not* the sample's: `selectSample` never copies the sample's recipe into the store, and `defaultRecipe()` is `'standard'`. So copying `:1804` into the click loop is a **no-op by default**. Silencing needs `effectivePolicy`, or the athlete choosing Minimal. *(I got this wrong too before an agent corrected me.)* The deeper point stands and is better: `voiceMode` carries two unrelated meanings — which dispatch path runs, and how chatty the coach is — and `:1684-1687`'s comment ("hand every punch call to the visuals") contradicts the 736 call clips that actually play. |
| 2 (`audibleUntilMs`) | HIGH | CONFIRMED, → LOW | **Five** production comparison sites, not six. The past-deadline case *is* test-locked at the implementation (`VoiceOutputExpo.test.ts:700-706`), which the package said was never exercised. And `:2076` is `&& !entry.firstRep`, so rep-0 calls would still dispatch. |
| 3 (unguarded tick) | HIGH | CONFIRMED | Severity *up*, not down: the headline thrower is dormant on the 22 samples but live on `diagnostic-token-sequence` and every generated workout (see P-4). |
| 6 (time bases) | HIGH | **UNDERSTATED** | See H-1. The package found the rare recovered-event case; the normal path is wrong on ~100% of punches. |
| 7 (window clamp) | MED-HIGH | → LOW | Not production-reachable. Inversion requires exactly `startOffsetMs > workDurationMs + graceBeforeMs`; the package's stated mechanism (re-expanding below authoring BPM) is algebraically impossible. |
| 8 (TDZ in monitor) | MED-HIGH | **REFUTED** | The TDZ window is *inside* the `try` opened at `:534`, so a synchronous listener runs on the same stack and the `catch` at `:624` does catch it. |
| 9 (metronome/avatar) | MEDIUM | OVERSTATED → LOW | The avatar half is refuted outright: `PunchAvatarCard.tsx:304-333` gates on the anchor *running*, and its comment names this exact bug as already fixed (GH #305). |
| 10 (BPM mismatch) | MEDIUM | → LOW | Not reachable on either path today; `bpmForRecipe` returns literally the same expression the generator used. |
| 12 (firmware v<4) | MEDIUM | CONFIRMED, docs-only | Stronger than stated: `INITIAL_STATE` and `parseFirmwareMajor` have **zero** callers anywhere, yet are publicly re-exported via `index.ts:20`. |
| 14 (`deferredBlockIds`) | MEDIUM | → LOW | `BlockKind` has **nine** members, not ten; exactly **one** is unrouted (`'sustained-strike'`), and it is unreachable from any shipped or generated workout. |
| 15 (`aggregateScores`) | MEDIUM | → LOW | **The function does not exist.** It is `scoreRound` (`cueScoring.ts:234`), which *does* have a test suite (`:238-266`) — so the package's "no test" half is refuted, and its own grep recipe returned empty for the wrong reason. The dead-code half stands. |
| 16 (`handAtCapture`) | MEDIUM | OVERSTATED → LOW | "Unreproducible from storage" is false: `punch_events.hand` is `NOT NULL` with a CHECK (`002:45`) and is written (`persistWorkoutSession.ts:152`). The loss is only about *re-decoding* a stored `ble_frames` row. |
| 18 (`velocityCalibrated`) | LOW-MED | CONFIRMED → LOW | The dropped value is losslessly recomputable from `velocity_raw` + `punch_type_raw` + `decoder_version`. |

Targets 4, 5, 11, 13, 17 confirmed with line-number corrections only. Target 5's
core claim needed one real correction: `MIN_BREATH_MS` **is** value-pinned, via
`clickCallFit.test.ts:85-116` across all 22 maps in both vocabularies.

### Found while fixing — one new finding

**N-1 · A deduplicated punch that a cue result names rolls back the whole
session · MEDIUM (narrow trigger, total loss).** `punch_events` has a unique
dedup index on `(device_address, tracker_timestamp_ms, punch_type_raw,
velocity_raw)` (`002_punch_events.ts:78-84`) and `appendPunchEvent` writes with
`INSERT OR IGNORE`. `persistWorkoutSession` writes the matched punches, then
the cue results that reference them by id. If two credited punches collide on
that key, the second insert is silently dropped, its cue result then names a
punch that does not exist, the foreign key fails, and the transaction rolls
back: the athlete finishes the workout and nothing is saved
(`workout.session.endWriteFailed`).

I hit this by accident — the new clock-origin fixture emitted two same-hand
punches with no tracker timestamp and the same reading, and the session write
failed. **What I have not established is whether hardware can do it.** Real
events carry distinct tracker timestamps, so it needs the same record
delivered twice as two events, *not* flagged `recovered`, and both credited
(a combination that calls the same hand twice would do it). H-1's change
narrows it — a replayed record older than three seconds is `recovered`, and
those are no longer credited — but does not close it. The fix is small and
local to `persistWorkoutSession`: have a cue result fall back to the surviving
row's id, or to `null`, when its punch was deduplicated.

**Status: fixed** (`7de47b95`). `appendPunchEvent` reports `storedId` — the row
that represents the punch, the survivor's when it was dropped — and
`persistWorkoutSession` points each cue result at it. Both slots keep their
credit and the session is saved. Whether hardware can trigger it is still
unestablished; it no longer matters for the record.

### Not reviewed — the honest gaps

Three subsystems nobody was assigned, ranked by where a real defect is most
likely:

1. **`tools/analysis/` correlators** — 918 + 492 + 1000 + 1383 lines. ~~No test
   anywhere in the repo~~ — **that was false.** `tools/analysis/__tests__/` has
   four suites (1,506 lines at the time): `verify-first-round`, `verify-suite`,
   `observed-timing`, `logcat-tag-aliases`, and jest runs them. What is true
   is narrower: the *click-path* behaviour of `verify-first-round` had no
   test, which is how its gates went unexamined (see the T-2 correction). It
   is still the layer the whole review trusted as ground truth, and
   `token-forensics.mjs` and the two drive scripts remain untested.
2. **The QA deep-link privilege model.** `src/app/qa/run.tsx:93-94` is a
   self-authorizing gate: it sets `enabled` from the request, then reads it back
   as the authorization. So `punchcraft://qa/run?workout=…&autostart=1&sim=…&qa=1`
   grants itself both privileged actions, and `setEnabled` **persists**
   (`useQaStore.ts:98-102`), so one link flips QA mode on permanently. The scheme
   is externally reachable (`app.config.ts:19`), `run.tsx:21` says nothing is
   gated on `__DEV__` because the suite runs release builds, and an autostarted
   sim run reaches `persistWorkoutSession` — so a web page can write a fabricated
   session with phantom punches. Notably the *load* path already fails closed,
   with a comment saying why: *"'on' grants autostart to an externally reachable
   URL"* (`useQaStore.ts:90-93`). The threat was understood; the request path
   just wasn't covered. Worth a look even on a personal device, because it also
   explains any mystery sessions in the DB.

   **Status: fixed** (`f9f758ee`). A link may switch QA mode *off* and may use
   it when it is already on; it can no longer switch it on. That is a switch
   in Settings and nowhere else. `qa=1` is logged as
   `workout.qa.run.cannotEnable` and ignored, and the screen says why the link
   only selected the workout. Cost: the unattended suite needs the switch
   flipped once per install.
3. **`src/storage` migrations.** `createMigratedDb()`
   (`__tests__/helpers/memoryDb.ts:83-92`) applies all eight migrations to an
   **empty** database. No test anywhere applies 001–004, inserts rows, then
   applies 005–008 — leaving 005's table rebuild (`:75-88`) and 007's backfill
   (`:109`) untested on the one path real devices actually take, under
   `PRAGMA foreign_keys = ON` inside a transaction. Also
   `SettingsRepository.read` is a blind `{...fallback, ...parsed}` spread
   (`:50`) with no per-field validation, and `overlayOptIn` flows from there to
   `VoiceCoachPolicy.ts:143` — the gate enforcing CLAUDE.md non-negotiable #9
   (never speak over third-party playback without opt-in).

   **Status: both done.** The upgrade path is tested on a database that holds
   data (`fa4f3291`) and it is sound — every assertion passed first time. What
   the work found instead is N-2 in §3b. Saved voice settings are checked
   field by field (`1d7ecdee`): the claim was real — a stored string `"false"`,
   a `1`, or an empty object in `overlayOptIn` each opened the D1 gate — and
   only literal `true` opts in now.

**Defect classes worth a dedicated sweep**, since this review was organised by
subsystem and cross-cutting classes were the blind spot: clock-domain collapse
(brand the three ms domains as nominal types); process-local values in durable
columns; unvalidated persisted reads; self-authorizing guards; and
absence-suppresses-failure in the analysis tools (T-2 is one instance — grep
every `?? `, `|| 0`, `=== 'unavailable'` feeding a pass/fail expression and check
its sign).

---

## 3b. The second batch — what each item became

Same day, branch `review/handoff-cycle-2`. The rule from the first batch held
again: re-derive the mechanism before fixing. It changed the work four times
here, and once it stopped me reporting something as far worse than it is.

### What was asked for

**QA link** (`f9f758ee`) — as planned. A link can use QA mode and can turn it
off; only the Settings switch turns it on.

**`voiceMode` split** (`308540cf`) — as planned, plus two things the plan did
not know:

- *The marker has to be saved.* A stored workout is rebuilt from its saved
  plan, and the old marker rode along inside the recipe. As its own field it
  was silently dropped on the way back; the full suite caught it. It is now
  in `blocks_json`.
- *The click-script loop is not specific to library workouts.* It runs on any
  bar the clip bank has a call for. In practice that is the library's
  motifs — `call/1-1-1-1` exists, `call/1-2` and `call/1-2-3` do not — so on
  a generated workout it rarely fires. (I said mid-batch that Minimal "still
  speaks per-bar calls on generated workouts today". That overstated it: only
  where a generated bar happens to match a library motif.)

What changes for an athlete: **Minimal now silences punch calls on library
workouts**, where before it changed nothing; and choosing Minimal on a
generated workout no longer switches off the reactive backdrop, which it did
by accident. Standard and Full are unchanged — and are, today, the same as
each other: nothing emits a `coaching-reminder`, the one category Full adds.
The picker says so.

**Sprint rounds** (`8538aa40`) — the mechanism was right this time: lifting
either count cap took sprint from 6 short cells in 144 (worst 6.9 s) to 0.
Both repair loops are bounded by progress now. Generator **1.3.1**.

**Repeat** (`1d0e33af`) — narrower than the plan. The plan said "the first
slot that overlaps no pending cue". What was built is "the slot right after
the current rep, or nothing". Reason: inside a block the next free slot is
the *next section's setup pause*, so a copy would arrive half a minute after
it was asked for and talk over the lead-in. What the old code actually did,
which the first write-up had only as "lands on the next rep": both cues came
due on one tick and the engine closed the **natural** rep as it opened — a
combination never shown, recorded as fully missed.

**Velocity Lab Live** (`8730db02`) — as planned, made conservative. It skips
the init writes only when the keepalive reports the glove fully up (armed,
plan finished, no errors). Anything less and it runs the full plan as before.
The screen itself has no test harness; the two pieces it calls are tested and
the wiring is typechecked only.

**Housekeeping** — errata and H13 (`bbfd5c4c`), runbooks (`e886924b`),
upgrade tests (`fa4f3291`), saved settings (`1d7ecdee`). Statuses are on the
items above (§1, and "Not reviewed" items 2 and 3).

### What it found on its own

#### N-2 · The rename edited a migration that has already run · **fixed**

`bd2ca682` changed migration 003's `sessions.mode` CHECK from `'puncheokie'`
to `'workouts'`, and `SESSION_MODES` with it. `schema_migrations` records
that a migration ran, not what it ran, so the edit would have left two
schemas under one id: a fresh install accepting `'workouts'`; the tablet,
whose table is never re-created, rejecting it — while typecheck and every
test, which build their database from the edited file, agreed with the edit.

**It was latent, not live.** I first read it as "every workout session will
fail to save", then traced the writer: `persistWorkoutSession` saves a
workout as `'punchcraft'` and nothing writes the third mode at all. So no
session was at risk; it was a trap for whoever next wrote that mode. It had
not reached `main`.

Fixed in `e9615f77` by restoring the shipped text — all eight migrations now
execute byte-for-byte the SQL on `main`, checked by fingerprinting `main`'s
own files — and guarded in `fa4f3291`, where each migration's executed SQL is
pinned. Re-applying the rename's edit fails two tests. `'puncheokie'` stays
as a stored identifier, like the tab directory. Renaming the stored value
properly is a new migration that rebuilds `sessions`; say if you want it.

#### N-3 · One announcement can cost a round its last 15-25 seconds · **open**

This is the real cause of the residual the first batch filed under "narrow
recipes run 12-29 s dry". It is not about narrow recipes.

`roundFill` fills a round to within 2 s of the bell, *then* runs the
"mandatory same-move announcement" pass: a run of one combination longer than
a minute gets a "settle in" call, whose time is paid for by popping trailing
blocks until the round fits again. It pops **whole blocks**, and nothing
tops the round back up. Measured on `{ seed: 'x', cap 2, steady, 20 min }`,
round 3: span 239.1 s → a 6.6 s reservation → pop a 2.1 s block (still over)
→ pop the next, a 12-rep pressure block worth 25.7 s → 218 s. A second
announcement then adds 7 s. The round ends at 225 of 240.

It needs a long single-combination run, so it shows up where variety is low:
a combination cap of 2 does it **with all six punches enabled** (15-25 s on
several seeds), as does jab-only. The recipe screen's warning does fire.
Fix, when wanted: trim reps off the last block instead of dropping it, or
re-run the top-up afterwards (checking it does not create a new unannounced
run). Either changes generated output, so it belongs with a version bump —
1.3.1 is still unpushed and could carry it.

#### N-4 · Some recipes generate a workout with nothing in it · **open**

A single enabled punch other than the jab (`[2]`, `[3]`, `[4]`, `[5]`,
`[6]`), and pairs like `[3,4]` or `[5,6]`, match no motif in the library:
**every round is laid empty**, 36 of 36 in the sweep. `[2,3]` and wider are
fine. The recipe screen says so accurately ("Every round runs out… up to
about 240 seconds") but as a warning beside a `jab-disabled` warning that
says only "variety will be reduced", and the workout can be started. Whether
an empty workout should be startable is a product call.

#### N-5 · A library workout's stored plan is frozen at its first save · **open, low**

`saveGeneratedWorkout` is `INSERT OR IGNORE` on the workout id, and a library
workout's id is fixed (`body-work`). So the plan row is whatever the first
build to run it wrote; a later build that re-authors the workout keeps
linking new sessions to the old plan. Nothing in the app reads plans back
today, and recalculation replays the per-session realized stream, not the
plan — so no visible effect yet. It will matter the day history shows a plan.

### Corrections to my own work in this batch

- A "passing" run that never ran: one jest invocation did not match the file
  I meant (unquoted parentheses in the path), and I read 315 green tests and
  two mutation results as evidence for tests that had not executed. The
  baseline was in fact red — the fixture's `1-2` bar has no call clip. Caught
  on the next run; fixture changed to a bar the bank can call; mutations
  re-run against a green baseline.
- The Repeat design was narrowed from what the approved plan said (above).
- N-2's severity, as described there.

---

## 4. The roadmap finding you asked me to verify first

**Verdict: confirmed, and narrower than stated in a way that strengthens the
plan.**

The scored path really is discipline-neutral. Verified independently:

- `ExpectedPunch` is exactly `{tokenIndex, hand, type?}` (`CueTimeline.ts:71-81`)
  — no number, no body, no notation, no stance.
- `CueMatcher.outcomeFor` (`:224-236`) is `hand !== expected.hand →
  'hand-mismatch'`, then `!tierScoresTechnique(this.tier) → 'matched'`.
  `FIGHTCAMP_V1_SOURCE_CAPABILITY` has `punchType: 'none'`
  (`TrackerPunchEventSource.ts:102-107`), so the short-circuit always fires and
  `'type-mismatch'` is unreachable.
- Grepping `CueEngine`, `CueMatcher`, `LiveCueMatcher`, `cueScoring` (261 lines),
  `workoutSummary` (273) and `cueResultRows` for
  `\.number|\.body|jab|cross|hook|uppercut|notation|stance` returns **zero**
  hits outside prose comments. The scored spine is genuinely vocabulary-free.
- `cue_results` is keyed on token indexes; `expected_type` is nullable and
  documented always-NULL. **No migration needed** for a new discipline — true as
  long as it reuses `orthodox`/`southpaw` and rides the `punchcraft` session
  mode. A 4th tab would need one (`003_sessions.ts:108`).

**Where it narrows:** "everything below the timeline needs zero change" is false
for three things that read boxing identity — `compileCue`/`strikeFor`,
`programCueBridge`, and `RhythmSpine`. They are not on the *scored* path, but
`compileCue` **is** on the unconditional live path:
`_useWorkoutRunner.ts:446-449` compiles spines in a `useMemo` with no gate. That
invalidates the framing that the V2 path is dormant and therefore low-risk —
a widened alphabet throws at spine build on every workout the moment the live
screen mounts.

**Funnel counts, corrected:** `resolveHand` one production caller ✓.
`strikeFor` one ✓ (defined at `strikeCatalog.ts:210`, not `:213`). 12
`.number`/`.body` sites under `src/domain/programs/` ✓. But the runner's "exactly
2 lines" is wrong — `:696` is right, `:850` is a *kind* filter with no number
read; the real second site is `:1122` (`formatCombo`), and a third the package
never lists is `live.tsx:552`.

### The two costs the roadmap defers that it should not

This is the one place I'd change the plan, and the reasoning is what matters:
**type costs don't scale with content; namespace costs do.**

Deferring the `ActionVocabulary` registry is right. Widening `PunchNumber`, the
`body` boolean, the four parity copies and the notation grammar is the same
mechanical edit whether 22 or 60 workouts exist. The three-row break-condition
table in `07:§3` is a genuinely good decision rule.

But two keys have **no discipline dimension**, and re-keying them gets more
expensive with every workout shipped:

1. **`call/<motif>` clip slots are a global namespace.** The runner builds
   `` const slot = `call/${motif}` `` (`_useWorkoutRunner.ts:698`), while lead-in
   and rest **are** workout-scoped (`live.tsx:485`, `:586` use
   `` `lead-in/${workout.id}/…` ``). Today that is 70 slots. Cuts both ways: a
   numbers-only MVP reusing existing motifs needs **zero** new call clips —
   cheaper than the package's quoted ~8. But the first time a non-boxing pack
   wants its own words, or any techniques vocabulary, the key must gain a
   segment, which re-keys call clips for all 22 shipped workouts plus
   `first-round-manifest.ts` and `make-click-script-clips.mjs` — and every
   re-key is an ASR-gated Chatterbox re-render, the slowest step in the loop.
   Until then, a second discipline's techniques vocabulary speaks **boxing
   technique names** for any shared motif, silently, with every test green.
2. **Avatar frames are keyed `(number, body)` only.**
   `findPunchAvatar(number, body)` (`punchAvatarManifest.ts:131`) over a flat
   12-entry array. The roadmap's Step 8 ("12 new source-art pairs, then run
   `make_punch_frames.py`") would regenerate the *same 24 keys* and overwrite
   boxing's art. There is nowhere to put a second set. The `guard.png` fallback
   is the right MVP call — but it is a structural blocker, not an art-scheduling
   choice.

Both are one function and one manifest generator today, and cost nothing if
boxing is spelled as the default/absent segment — no test expectation moves.

### Other roadmap corrections worth keeping

- **Step 2's gate is vacuous.** "22 snapshots cover this" — they are *token
  stream* snapshots (`samples.test.ts.snap`, entries like `"1@0"`, `"2b@1"`).
  Moving label tables cannot move them. Worse, Steps 2 and 3 touch
  `src/components/workout/` while the stated gate runs only `src/domain/*`, so
  both ship ungated. One-word fix: add `src/components` to the gate.
- **Step 4 mints a 23rd snapshot** (registering in `samples/index.ts` ORDER),
  fine locally, fails under `--ci`. Write it deliberately.
- **Step 10 orders its two crashes backwards.** `vocabulary.ts`'s
  `comboPhraseAssets` `RangeError` (`:60-65`, not `:62-66`) is real, but
  `compileCue.ts:384-386` throws *earlier* in wall-clock terms — at spine build
  on the `useMemo`, before any cue event fires.
- **`generateWorkout`/`roundFill` run on every live-screen mount**, including
  sample workouts (`live.tsx:299-340`, unconditional `useMemo`; the sample-vs-
  generated choice happens later at `:341-342`). The *output* is discarded; the
  *code* always runs. So "leave roundFill alone" is right about not changing it
  and wrong about it being unreachable.
- **`PunchToken` renders the digit at three sites** (`:151`, `:202`, `:228` —
  base, active, completed), not one.
- **`clickMapsSelfCheck` is stricter than Step 5 says:** bars are 4 or 8 slots
  exactly (`clickMaps.ts:174-177`), even reps for an 8-slot row at rate 2
  (`:178-180`), no 8-slot at rate 1.5 (`:181-183`), **no digits in spoken copy**
  (`:188-190`).
- **The simultaneous-two-handed warning is right; its arithmetic is wrong.** An
  authored `[left@0, right@0]` where the right glove transmits first yields one
  match, **one** extra and **one** miss — not "two extras and two misses". Worth
  correcting so the signature is recognisable in a log.
- **Step 7 has two unstated prerequisites:** `verify-suite.mjs:374-381` throws
  without a manifest per vocabulary, and `first-round-manifest.ts` runs
  `compileWorkoutScore` on every sample — so the V2 score path cannot be treated
  as out of scope for a new discipline's QA.

### Recommended MVP

A numbers-only, 2-round, 4:00-per-round **reaction / target-tap** workout
("call a code, answer with the correct hand"), authored as a literal `ClickMap`,
reusing digits 1–6, the `b` variant, `'repeated-combo'`, `guard.png` for every
frame, and — deliberately — **only motifs already among the 70 `call/` slots**.

Why this shape: it is the only one honest about what the hardware can confirm.
The tracker verifies a left/right sequence and nothing else, so a discipline
whose whole premise is "was the right hand thrown on cue" is scored at full
fidelity, with no summary quietly claiming more than it knows. A target tap is
also above the transmit floor by construction, which forecloses the softer
disciplines. And because `call/<motif>` is global, the per-bar calls are
*already rendered* — in the numbers vocabulary the copy is literally "One, two,
three, two!", which is discipline-neutral. Render budget collapses from the
package's ~16 wavs to about **8**: ~6 section lead-ins (workout-scoped, no
collision), 1 rest script, 1 walkout. One Chatterbox batch, one `speaker_audit`
pass. **Zero engine lines changed.**

### Hard limits, re-verified

Technique is permanently unverifiable (`punchType: 'none'`). Exactly two scored
streams, forever (`KNOWN_TRACKERS` is a two-element literal; hand comes from the
connection slot). Soft/slow/controlled movement cannot be scored at all — D13,
`docs/workouts-ux-engine.md:1069`; ten deliberately soft uppercuts produced
exactly one event, and `004_workouts.ts:76` records that `'missed'` therefore
covers "below the transmit floor" and may not be shown as failure. The spoken
vocabulary is closed at build time (D16) — `comboPhraseAssets` throws rather
than degrade. Simultaneous bilateral actions cannot be graded. No limb but the
two hands. And the trackers must be OS-bonded ("FightCam") or every link dies at
~37 s — still documented nowhere in the repo; it belongs in
`docs/protocol/hypotheses.md` as the next free H-number.

---

## 5. What I'd do first

Restore the two instruments before fixing any finding, because right now neither
the suite nor the verification loop can tell a fix from a regression — and a
blind fix to a clock-base error is how this project loses another session.

1. **T-1** — one token in `jest.config.js`. Unblocks every worktree session.
2. **T-2** — move the timeline-hash log out of the score-path branch so every
   workout emits provenance; invert the polarity at
   `verify-first-round.mjs:576` so absent provenance escalates. Until this
   lands, every green suite and every LOOP-ledger WARN is uninterpretable.
3. **Flip `createFakeClock`'s default origin off 0** and triage the fallout.
   That single edit mechanically localizes the whole clock-domain class,
   including instances nobody has found, and exposes the fixtures that cheat.
4. **Then H-1**, with a clock-origin invariance test that can prove it:
   `describe.each([0, 1_000, 3_600_000, 86_400_000])` over the runner, punches
   driven from `SimulatedPunchSource` on the *same* clock (never hand-written
   from the cue), asserting `offsetMs` within ±1 ms of 0, `timingWindowPct` 100
   not 0, and the full persisted row set deep-equal across all four origins.
   Today origin 0 passes and origin 3_600_000 fails by exactly 3_600_000 —
   which both proves the bug and names its magnitude.
5. **P-2** (4-line allowlist) so PR #390 can go green, and **P-6** (commit the
   two runbooks, 24 KB) — both cheap, both unblock everything downstream.
6. Then H-2, H-3, H-4 and the MEDIUMs, each verifiable by reading the diff.
7. Roadmap: the namespace Step 0, then the reaction-drill MVP.

---

## 6. Decisions I need from you

1. **Order.** Instruments first (my recommendation), or go straight at H-1…H-4?
2. **PR #390.** Merge it first with the allowlist fix, or keep working on this
   branch and fold the review in?
3. **The `voiceMode` collision** (package target 1). Leave the asymmetry and fix
   the two misleading comments, or split the flag into "which dispatch path" and
   "how chatty the coach is"? The second is the real fix and it is a bigger
   change.
4. **Which discipline** is the actual target? My reaction/target-tap MVP is a
   guess chosen to minimise cost. If you have a real one in mind, the Tier A/B
   call turns entirely on whether it fits ≤6 alternating-hand roles × one binary
   variant.
5. **The QA deep link** (§3, gap 2). Worth closing, or accepted risk on a
   personal device?
6. **`roundFill`'s repair cap** (H-4 piece 3) — a tuning question I won't touch
   without your ear.

**Where these stand at the end of 2026-11-25.** (1) Answered: HIGHs first, then
N-1, the instruments and the MEDIUMs — all done. (2) Half answered: the
allowlist is in, so PR #390 can go green; whether to merge it before this
branch is still yours. (6) Answered for the clamp, which was the actual cause
and is fixed; the repair cap proper turned out to be a much smaller, separate
residual at sprint cadence (see H-4) and is still a listening question.
(3), (4) and (5) are open.

**After the second batch.** The sprint residual is fixed (`8538aa40`); what
is left to listen to is how those rounds now end. Open and yours to decide:
whether to fix **N-3** (a round losing its last 15-25 s to an announcement —
1.3.1 is unpushed and could carry it), whether an empty workout should be
startable (**N-4**), whether to rename the stored session mode with a real
migration (**N-2**), and still which discipline the first non-boxing workout
targets.

---

## 7. What only the tablet, or a suite drive, can verify

Nothing below is proven by jest. Every item needs a Metro restart **and** a
cold app restart first — `F:` has no fast refresh.

**Bluetooth (H-3) — the one that matters most.**
- Gloves connected → Velocity Lab → Live → back → start a workout → punches
  count. Then the same through Velocity Lab → Probe.
- With a glove that drops and reconnects while a Velocity Lab screen is open,
  leave the screen: the workout still counts.

**On the bag.**
- H-1: an on-beat matched punch now gives the stronger buzz. It never has
  before; decide whether you want it.
- H-2: back mid-round stops the workout and shows the dialog; a second back
  leaves; the session is in the database as cancelled.
- M-1: pause mid-combination and throw — counters do not move, no buzz, and
  the combination is not credited on resume.
- M-4: after Stop, and after a natural finish, counters do not move.
- M-2: "Voice coach: Off" with any library workout — no bell, no sound.
- M-3: Stop → Discard removes the session; Stop → Save keeps it.
- M-6: flip numbers ⇄ techniques while the rest walkthrough is speaking — it
  finishes in the vocabulary it started in.
- M-5: hold Repeat on the **last** rep of a block, finish the round — an
  extra rep is thrown and the session saves. Held on any earlier rep of a
  tight block, Repeat now does nothing (the next rep is the same
  combination); that is the change in `1d0e33af`, and the thing to judge is
  whether "nothing" needs to say so on screen.

**Recipe screen.**
- Duration 20 → 60 shows a goal of 2,700 and the same intensity label.
- Advanced → enable only punches 1 and 2 and cap combinations at 2 → the
  warning appears in the summary and beside the punch toggles. (Whether a
  given build runs dry depends on its seed; it did for the one I tried.)

**By ear.**
- A generated workout at a low goal (try 60 minutes at 900): every round is
  now full to the bell. Is that the round you want, or too dense?
- Any generated workout: the generator is at **1.3.1**, and each bump reseeds
  selection, so a saved seed no longer gives the workout it used to.
- A sprint-cadence workout: rounds now run to the bell. The last few seconds
  are more of the closing combination — is that the ending you want?
- Voice coach **Minimal** on a library workout: bells, stance changes and the
  countdown, and no spoken punch calls or section lead-ins. Nothing on screen
  should sit dimmed waiting for a call. Standard should sound exactly as it
  did.

**Velocity Lab Live, with the gloves already connected.** The log should show
`punchstream.init.skipped` and the screen "glove already initialised by the
app; listening only". Punches still appear. Then start a workout: its
timestamps should not have jumped.

**The upgrade itself.** Installing this build over the one on the tablet is
the real migration test. Nothing here changes the schema, so it should be a
no-op; worth one look at `SELECT mode, COUNT(*) FROM sessions GROUP BY mode`
to learn whether any stored session carries `'puncheokie'` (N-2).

**The QA suite (T-2).** First switch QA mode on in the app — Settings → QA
mode — once per install; the link no longer does it, and a drive without it
reports `qa-flag-off` and says where the switch is. Then one full drive to
re-baseline the ledger. Expect:
every capture to carry a `workout.timeline.provenance` record and read
"verified"; no workout to read STALE; verdicts that were PASS to become WARN
where loop-call coverage is under 90%, and FAIL where a clip failed to load
or play. A capture from a build without QA enabled reads WARN (unverified)
by design.
