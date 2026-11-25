# Adversarial review targets (verified at HEAD 8b7e79a2)

## Adversarial review targets — punchCraft

All 18 targets below were confirmed by reading the code at `F:/punchCraft`, HEAD `8b7e79a2` (main, 2026-09-26). Line numbers are as of that commit. Two plausible-sounding suspicions were **refuted** and are recorded at the bottom so a new session does not waste time on them.

Ranked by expected value = (likelihood a change trips it) × (blast radius) × (how cheaply a reviewer can confirm it).

---

### 1. The live coach path skips the category gate the score path applies — "fixing" the inconsistency silences every shipped workout

**Severity: HIGH**

| | |
|---|---|
| Files | `F:/punchCraft/src/app/(tabs)/punchcraft/_useWorkoutRunner.ts:1800-1804` (score path), `:2064-2080` (click path); `F:/punchCraft/src/domain/coach/VoiceCoachPolicy.ts:151-156`, `:168-189` |

**What is suspect.** There are two coach dispatch paths and they apply different gates.

The score path (SlotDispatcher `play` callback) applies both gates:

```ts
// _useWorkoutRunner.ts:1800-1804
if (!voiceAllowed(voice.policy, playbackActiveRef.current)) return
// Category gate: a combo-announce is a punch command, which
// `minimal` mode leaves to the visuals. `inCombo: false` — the
// announce lands at block start, before the work.
if (!shouldSpeak(voice.policy, 'punch-command', false)) return
```

The click-script path applies only the first:

```ts
// _useWorkoutRunner.ts:2067 (inside the lead-in/call dispatch loop)
if (!voiceAllowed(voice.policy, playbackActiveRef.current)) continue
```

There is no `shouldSpeak` call anywhere in that loop. Confirmed by grep: the only `shouldSpeak` reference in the runner is the import at `:77` and the single call at `:1804`.

**Why it is risky.** `shouldSpeak` short-circuits at `VoiceCoachPolicy.ts:189`:

```ts
if (p.mode === 'minimal' || p.style === 'minimal') return MINIMAL_CATEGORIES.has(c)
```

and `MINIMAL_CATEGORIES` (`:151-156`) is exactly `{'stance-change', 'bell', 'final-countdown', 'metric'}` — `'punch-command'` is **not** in it. Every one of the 22 shipped click workouts sets `voiceMode: 'minimal'`, so `scoreDispatchEnabled = workout.recipe.voiceMode !== 'minimal'` (`:1759`) is false, the SlotDispatcher is never constructed, and the click path is the only thing speaking. Per-bar calls are audible **only because the gate is missing there**. A reviewer who notices the asymmetry and "harmonises" the two paths will make the coach go completely silent on all 22 workouts, and the comment at `:1801-1802` will read as justification for having done it. The symptom (total coach silence, no error) is also indistinguishable from several other failures in this subsystem.

**How to confirm/refute in minutes.** `grep -n "shouldSpeak" 'src/app/(tabs)/punchcraft/_useWorkoutRunner.ts'` — expect exactly two hits (import at 77, call at 1804), neither inside the `leadInScheduleRef` loop that starts at `:2046`. Then `node -e "const{shouldSpeak}=require(...)"` or simply read `MINIMAL_CATEGORIES`. No test covers it: there is no test asserting a `minimal` recipe still produces audible per-bar calls.

**Recommended review action.** Decide and *document* which gate governs the click path. If the current behaviour is intended, add a test named for it (`minimal mode still calls every bar on the click path`) so nobody "fixes" it, and amend the `:1801-1802` comment to say it applies to the score path only.

---

### 2. `audibleUntilMs() > 0` is used as "busy" at six call sites, but the port contract explicitly permits a value that breaks all six

**Severity: HIGH**

| | |
|---|---|
| Files | `F:/punchCraft/src/domain/coach/VoiceOutputPort.ts:605-620` (contract), `F:/punchCraft/src/audio/VoiceOutputExpo.ts:798-801` (impl), consumers: `_useWorkoutRunner.ts:1820-1821`, `:2067`, `:2076`; `F:/punchCraft/src/domain/coach/CueAnnouncer.ts:543-544`, `:576-577`, `:837-838` |

**What is suspect.** The interface documents the return value as an *absolute clock instant*, and explicitly blesses a stale one:

```
// VoiceOutputPort.ts:606-609
 * The clock instant, in the same `clock()` reference the port uses,
 * up to which the coach track is expected to still be audible from
 * a currently sounding clip. `0` (or clock-in-the-past) means the
 * coach is quiet right now.
```

Every single consumer treats *any* non-zero value as busy. The click-script dispatch loop:

```ts
// _useWorkoutRunner.ts:2067, 2076
const audibleUntilMs = voice.output.audibleUntilMs?.() ?? 0
...
if (audibleUntilMs > 0 && !entry.firstRep) {
  continue   // retry next tick
}
```

Same shape at `_useWorkoutRunner.ts:1821`, `CueAnnouncer.ts:544`, `:577`, `:838`.

**Why it is risky.** It works today only because `VoiceOutputExpo` happens to normalise internally:

```ts
// VoiceOutputExpo.ts:798-801
audibleUntilMs(): number {
  const now = this.clock()
  return this.busyUntilMs > now ? this.busyUntilMs : 0
}
```

So the contract and the consumers disagree, and the implementation is the only thing holding the system together. Consequences of any divergence: an implementation that returns the raw deadline (which the doc says is legal) permanently wedges the coach lane — every per-bar call `continue`s until `giveUpAtMs`, every call is skipped, and the *only* signal is an absent `puncheokie.clickScript.dispatch` log line, because a skipped **call** deliberately does not warn (`:2056-2061` warns for `kind === 'lead-in'` only). Note `msUntilQuiet()` at `:814-817` already has to defend against the same ambiguity (`until > 0 ? Math.max(0, until - this.clock()) : 0`), which shows the author knew the value is awkward.

Secondary smell in the same spot: the dispatch loop compares a value stamped on `VoiceOutputExpo`'s own `clock()` (defaults to `performance.now()`) against nothing, while all its scheduling decisions use `snapshot.workElapsedMs`. The comparison is self-contained today, but any attempt to compute "how long until free" at the call site will silently mix clock domains — `VoiceOutputExpo.ts:806-809` warns about exactly this.

**How to confirm/refute.** `grep -rn "audibleUntilMs" src/ --include=*.ts --include=*.tsx | grep -v VoiceOutput` — six production call sites, all `> 0`. Then read `VoiceOutputPort.ts:605-620`. In the test mocks, `CueAnnouncer.test.ts:85` stubs `audibleUntilMs(): number` and `:643` does `Object.assign(h.port, { audibleUntilMs: () => audibleUntil })` — so tests only ever feed 0 or a clearly-future value; the clock-in-the-past case is never exercised.

**Recommended action.** Either tighten the contract to "returns 0 when quiet, never a past instant" (and add that to the port doc), or give the port an `isCoachAudible(): boolean` and migrate the six sites.

---

### 3. The 50 ms runner tick has no `try`/`catch`, while `SlotDispatcher` documents that "the runner surfaces the error"

**Severity: HIGH**

| | |
|---|---|
| Files | `F:/punchCraft/src/app/(tabs)/punchcraft/_useWorkoutRunner.ts:1998-2190`; `F:/punchCraft/src/audio/SlotDispatcher.ts:151-153`; `F:/punchCraft/src/domain/programs/CueEngine.ts:184`, `:640-652` |

**What is suspect.** The entire ~190-line interval body is unguarded. Verified: `awk 'NR>=1996 && NR<=2200' … | grep -n "try {\|} catch"` returns **nothing**.

Inside that body, in order: `session.advance()`, `applyTransitions()`, `announcer.onRoundClock()`, `vizRef.current.tick()`, `engine.tick()` (`:2022`), `announcer.onTick()`, `slotDispatcher.advance()`, the click-script dispatch loop with `voice.output.playClickScript?.()`, and `metroPort.start()`.

At least three of those are *documented to throw*:

- `CueEngine` constructor/`loadRound` → `assertWindowsClamped` **throws** on a bad window (`CueEngine.ts:640-652`), and `assertSingleActive()` is called from `:184`.
- `SlotDispatcher.advance` — its own docstring says: *"Throws whatever `play()` throws; a throw from `play()` does NOT re-queue the slot — it is marked dispatched and the runner surfaces the error."* (`SlotDispatcher.ts:151-153`). The runner does not surface it; it has no catch. Comment and code disagree.

**Why it is risky.** A throw at 20 Hz. This repo already has a documented precedent for exactly this failure mode: `MetronomeTransport.correct` summarises its holds at 1 Hz because *"a measured baseBpm/loop mismatch produced ~500 transport-hold logs/sec and red-screened the JS thread"*, and `vizForensics` exists (`src/diagnostics/vizForensics.ts`, `FLUSH_INTERVAL_MS=500`, `CLOCK_ANOMALY_MS=250`) on the principle that instrumentation must not perturb what it measures. A 20 Hz exception storm mid-workout is the same class of JS-thread death, and the athlete is mid-round on a bag with no way to stop it cleanly.

**How to confirm/refute.** Read `:1998` to the closing `}, [...]` at `:2193`. Then inject a throwing `play` into `SlotDispatcher` in a jest test of the runner and observe that nothing catches it. Also check: does the engine's `assertWindowsClamped` run only in the constructor, or also on `loadRound`? (`:126` is the constructor call; `loadRound` resets `lastTickMs = -1` at `:299` — see target 7 for how an inverted window gets past the assertion in the first place.)

---

### 4. Shipped click-script clip ids are the sha1 of the **pre-override** text, so `--missing-only` will never re-render five clips — and the comment claims the opposite

**Severity: HIGH**

| | |
|---|---|
| Files | `F:/punchCraft/tools/voice/make-click-script-clips.mjs:102-130` (`hash8`/`assemble`), `:292` (wav path), `:294-307` (override application), `:385-394` (`--missing-only`); `F:/punchCraft/src/audio/voiceAssets/clickScriptManifest.ts:331` |

**What is suspect.** The order of operations breaks the id↔text invariant. `assemble` mints the id from `row.text`:

```js
// make-click-script-clips.mjs:120-121
id: `${prefix}-${hash8(row.text)}`,
```

the wav path is then frozen from that id at `:292`:

```js
].map((job) => ({ ...job, wav: join(process.cwd(), OUT_ROOT, `${job.id}.wav`) }))
```

and only **afterwards** does `CALL_CLIP_OVERRIDES` rewrite the text (`:299-307`):

```js
if (raw?.text !== undefined) {
  j.text = raw.text
  j.plan = { ...j.plan, renderedText: raw.text }
}
```

Verified numerically: `sha1('One! One! One! One!').slice(0,8) === '41b6f3bf'`, `sha1('Four ones!').slice(0,8) === 'b2fd3d39'`. The shipped manifest row is:

```ts
// clickScriptManifest.ts:331
{ id: 'cc-41b6f3bf', kind: 'call', vocabulary: 'numbers', text: "Four ones!", slots: ["call/1-1-1-1"], module: require('.../cc-41b6f3bf.wav'), durationMs: 889 },
```

**Why it is risky.** The `--missing-only` filter is a pure file-existence check against that frozen path:

```js
// make-click-script-clips.mjs:385-393
// `--missing-only`: render only texts with no wav yet — ids are text
// hashes, so an unchanged text keeps its clip and a map edit re-renders
// exactly the copy it touched.
const missingOnly = process.argv.includes('--missing-only')
...
if (missingOnly) return !existsSync(j.wav)
```

The comment's stated invariant ("a map edit re-renders exactly the copy it touched") is **false for the five overridden slots**: editing an override's `text` does not change `j.id`, the wav still exists, and the renderer skips it. A stale wav keeps shipping under a manifest text that no longer matches its own hash — and the ASR gate, the token audit and the manifest all read the *new* text, so every automated check agrees with each other and disagrees with the audio on disk. This is precisely the class of defect that `:294-298` says the 2026-09-11 plumbing hardening was supposed to close.

The five affected ids: `cc-41b6f3bf` ('Four ones!'), `cc-9189c64b`/`cc-5a20138e`/`cc-e17a56ba` (the twos/fives/body-ones entries), `ct-d7c94e92` ('Four jabs!'). Re-renders of these must use explicit `--only-keys=`.

**How to confirm/refute.** One command:
```
node -e "const c=require('crypto');console.log(c.createHash('sha1').update('Four ones!').digest('hex').slice(0,8))"
```
→ `b2fd3d39`, which is not the id in the manifest. Then `grep -rn "createHash" src/ --include=*.test.ts` → **zero hits**: nothing in the test suite pins `id === prefix + sha1(text)`.

**Recommended action.** Either apply overrides before `assemble` (so the id follows the canonical text), or add an integrity test over `clickScriptManifest.ts` asserting `id.slice(3) === sha1(text).slice(0,8)` with an explicit, named allowlist for the override rows.

---

### 5. Every ear-tuned timing constant is pinned only *relationally* — the test suite structurally cannot catch a regression in any of them

**Severity: HIGH**

| | |
|---|---|
| Files | `F:/punchCraft/src/domain/coach/callPlacement.ts:38`, `:47`, `:76`, `:91`, `:94`, `:104`, `:119-122`, `:194`, `:232-235`; `F:/punchCraft/src/domain/coach/__tests__/callPlacement.test.ts`; `F:/punchCraft/src/app/(tabs)/punchcraft/__tests__/breathForBar.test.ts`; `F:/punchCraft/tools/analysis/timing-constants.mjs` |

**What is suspect.** Every assertion in `callPlacement.test.ts` uses the constants themselves as the expected value:

```ts
// callPlacement.test.ts:52
expect(breathMs).toBe(DENSE_BREATH_MS.numbers - (600 - BREATH_REF_SLOT_MS))
// :122
expect(placed.dispatchAtMs).toBe(10_000 - 1_400 - DENSE_BREATH_MS.numbers - CALL_DISPATCH_LAG_MS)
// :160
expect(placed.dispatchAtMs).toBe(rep0.dispatchAtMs - LEAD_CLIP_MS - LEAD_IN_PAD_MS)
```

Verified: `grep -n "toBe(250)\|toBe(71)\|toBe(500)\|toBe(95)\|toBe(120)"` across `callPlacement.test.ts` and `RhythmMap.test.ts` returns **nothing**. Not one constant is pinned to a literal.

Worse, `CALL_BREATH_OVERRIDES` — the *approved* narrowly-scoped fix for GH #368, `{'call/1-.-.-.': 340, 'call/1-.-2-.': 340}` at `callPlacement.ts:232-235` — is referenced by **no test at all** (`grep -n "CALL_BREATH_OVERRIDES" src/domain/coach/__tests__/callPlacement.test.ts 'src/app/(tabs)/punchcraft/__tests__/breathForBar.test.ts'` → nothing).

**Why it is risky.** This is not theoretical; it already happened. Commit `ea5df336` raised `LEAD_IN_PAD_MS` 250→282 and `DELIVERED_BREATH_SHORTFALL_MS` 95→127; the full jest suite stayed green, and the regression was caught only by a 24-workout on-glass drive (quick-uppercut-lane −113.5 ms, establish-the-jab-20 −32.5 ms, switch-by-round −24.7 ms; 4 FAIL / 1 ERROR / 17 WARN / 0 PASS), then reverted in `1af8a232`. The same change would pass CI today.

Compounding it from the other side: `tools/analysis/timing-constants.mjs` recovers these values by **regexing the TypeScript source** (`readNumberConst`, `readRecordConst`, `readOverrides`) and reports a miss as `not found (renamed?)` rather than failing. So a rename silently nulls the analyzer's reference values *and* the two 340 ms overrides silently stop applying, with nothing red anywhere. `DENSE_BREATH_MS` is additionally a *sum* of other constants resolved by `evalSum`, so adding an unresolvable term drops the entry entirely.

**How to confirm/refute.** Change `CALL_DISPATCH_LAG_MS` from `71` to `500` in `callPlacement.ts:76` and run `npx jest src/domain/coach src/app/\(tabs\)/punchcraft` — expect green. Rename `CALL_BREATH_OVERRIDES` and run `node tools/analysis/timing-constants.mjs` — expect a `not found` line, exit 0.

**Recommended action.** Add a cheap `callPlacementConstants.test.ts` that pins each constant to its literal with the measurement provenance in the test name (so the test *is* the changelog), plus one test that `breathForBar(bar([0]), 'numbers', 'call/1-.-.-.')` returns exactly `340`. This makes any re-tune a deliberate, reviewed test edit rather than a silent one.

---

### 6. `CueMatcher` sorts and subtracts two different time bases; `LiveCueMatcher` feeds recovered events into the authoritative pass despite a comment saying it does not

**Severity: HIGH**

| | |
|---|---|
| Files | `F:/punchCraft/src/domain/programs/CueMatcher.ts:86-91`, `:138`, `:145`, `:173`; `F:/punchCraft/src/domain/programs/LiveCueMatcher.ts:209` vs `:233`, `:329-362`; `F:/punchCraft/src/storage/cueResultRows.ts:71` |

**What is suspect.** `eventTimeMs` returns values from two unrelated clocks:

```ts
// CueMatcher.ts:86-91
function eventTimeMs(event: TrackerPunchEvent): number | null {
  if (event.recovered) {
    return typeof event.trackerTimestampMs === 'number' ? event.trackerTimestampMs : null
  }
  return event.receivedMonotonicTimeMs
}
```

`receivedMonotonicTimeMs` is `performance.now()` (set in the ble-plx callback, `BleManagerBlePlxImpl.ts:541`) — order 1e4–1e7. `trackerTimestampMs` is Unix epoch ms (`FightCampV1Decoder.ts`, `epochSeconds * 1000 + …`) — order 1.79e12. They are then mixed:

```ts
// CueMatcher.ts:138
timed.sort((a, b) => a.atMs - b.atMs || a.event.id.localeCompare(b.event.id))
// :145  (gate === 'window')
if (gate === 'window' && (atMs < cue.windowStartMs || atMs > cue.windowEndMs)) { ... }
// :173
offsetMs: atMs - this.scheduledMomentMs(cue, expected),
```

And `LiveCueMatcher` buffers the recovered event *before* skipping it:

```ts
// LiveCueMatcher.ts:209
open.events.push(event)
...
// :230-233
// A recovered event cannot be placed provisionally — its position
// depends on a tracker timestamp the settled pass will order properly.
// Buffer it and say nothing yet rather than crediting the wrong slot.
if (event.recovered) return
```

`settle()` then calls `matcher.match(cue, open.events, { gate: 'open' })` (`:329-362`).

**Why it is risky.** Under `gate: 'open'` — which is the live path, and which deliberately **skips** the window test — a recovered event sorts last (1.79e12 ≫ everything), takes the next unfilled ordinal, and produces `offsetMs ≈ 1.79e12`. That value is written straight to `cue_results.offset_ms` via `cueResultRows.ts:71` (`offsetMs: assignment?.offsetMs ?? null`), poisoning any stored-session timing analysis. It also means a real, on-time punch can be displaced out of its slot by a backfilled one.

The exposure is routine, not rare: per `trackerKeepalive.ts:119-146`, the heartbeat writes mode-normal (`MODE_NORMAL_BASE64 = 'AQ=='`) to `CHAR.COMMAND1` every 20 s, and a mode-normal write is the buffer-drain trigger — so backfilled records arrive **mid-workout**, at any heartbeat tick, not only on reconnect. Anything >3 s behind arrival is flagged `recovered` (`BACKFILL_THRESHOLD_MS = 3_000`, `FightCampV1Decoder.ts:184-191`).

**How to confirm/refute.** Existing tests cover `gate: 'window'` only (`CueMatcher.test.ts:289-324`, "recovered events") and the provisional-skip (`LiveCueMatcher.test.ts:133`, `:234`). Write one test: open a cue, push a normal event and a `{recovered: true, trackerTimestampMs: Date.now()}` event, call `settle()`, and assert on the resulting `assignments[].offsetMs`. Expect an absurd magnitude.

**Recommended action.** Normalise at the source — give `TrackerPunchEvent` a single comparable `atMonotonicMs` derived once (recovered events can carry a reconstructed monotonic estimate, or be excluded from `open.events` entirely). Note the decoder's own comment at `FightCampV1Decoder.ts:156-163` already *claims* recovered events are excluded from live matching; make that true.

---

### 7. `expandCountScoredBlock` omits the upper clamp its sibling has — and `assertWindowsClamped` is blind to the resulting inverted window

**Severity: MEDIUM-HIGH**

| | |
|---|---|
| Files | `F:/punchCraft/src/domain/programs/CueTimeline.ts:412-415` vs `:485`; `F:/punchCraft/src/domain/programs/CueEngine.ts:640-652` |

**What is suspect.** `expandBlock` clamps `windowStartMs` on both sides, with a 12-line comment explaining exactly why the upper clamp is not redundant:

```ts
// CueTimeline.ts:405-415
//      The upper clamp on the start is not redundant. `repeat` lays
//      instances at a beat-derived stride that expansion never checks
//      against the round length, so a repeated combo can be scheduled
//      wholly past the bell — most easily by re-expanding a workout below
//      its authoring cadence, which is what PacingEngine (M33-05) does.
//      Without it such a cue gets `windowStartMs > windowEndMs`: an
//      inverted window that no clamp assertion downstream is looking for.
windowStartMs: Math.min(
  ctx.workDurationMs,
  Math.max(0, scheduledStartMs - ctx.graceBeforeMs),
),
```

`expandCountScoredBlock`, 70 lines later, does not:

```ts
// CueTimeline.ts:485
windowStartMs: Math.max(0, scheduledStartMs - ctx.graceBeforeMs),
```

Confirmed: `grep -n "windowStartMs: Math" src/domain/programs/CueTimeline.ts` → exactly two hits, `:412` (clamped both ways) and `:485` (floor only).

**Why it is risky.** The guard the comment names as absent is genuinely absent:

```ts
// CueEngine.ts:643
if (cue.windowStartMs < 0 || cue.windowEndMs > round.workDurationMs) { throw ... }
```

It never tests `windowStartMs > windowEndMs`. `truncateWindowsAtNextCue` (`:334-340`) cannot save it either — it only lowers `windowEndMs` (floored at `windowStartMs`) and the *last* cue in a round is never touched by it at all. So a count-scored block scheduled past the bell yields an inverted window that the engine happily loads, and `CueMatcher` under `gate: 'window'` then rejects every punch (`atMs < windowStartMs`) — a burst silently scoring zero, with the comment at `:481-483` ("Graces still apply and still clamp to the work interval: a burst's window may not outlive the round any more than a combo's may") asserting the opposite of what the code does.

`grep -rn "windowStartMs > windowEndMs\|inverted"` across `src/domain/programs/**` returns only the two comment lines — **no code and no test**.

**Reachability** is real and compounds with target 10: count-scored kinds (`volume-burst`, `open-pressure`, `coast`, `active-recovery`, `CueTimeline.ts:190-199`) are emitted by the generator, and the generator lays blocks at `CADENCE_PROFILES[...].nominalBpm` while the runner re-expands at `bpmForRecipe(...)`.

**How to confirm/refute.** One unit test: build a `GeneratedWorkout` with a single `volume-burst` block whose `startOffsetMs` exceeds `workDurationMs`, call `expandTimeline`, and assert `windowStartMs <= windowEndMs`. Expect failure. Then confirm `new CueEngine(timeline)` does **not** throw.

---

### 8. Temporal-dead-zone hazard in `monitorCharacteristic`: a synchronous first callback throws, and `setupOutcome` then never resolves — hanging the whole glove init

**Severity: MEDIUM-HIGH**

| | |
|---|---|
| Files | `F:/punchCraft/src/ble/BleManagerBlePlxImpl.ts:535-611`; `F:/punchCraft/src/protocol/PunchStream.ts:169` |

**What is suspect.** The callback closure references `result`, which is declared *after* the call that installs the callback:

```
535:  const sub = manager.monitorCharacteristicForDevice(
539:    (err, characteristic) => {
541:      const monotonicTimeMs = performance.now()
544:      if (!setupObserved) {
545:        setupObserved = true
546:        if (err) {
547:          result.success = false        // <-- TDZ if this runs before line 600
...
597:    },
598:  )
599:  this.monitorSubs.set(key, sub)
600:  const result: SubscriptionResult = {
601:    serviceUuid, characteristicUuid, direction, success: true,
602:  }
606:  setTimeout(() => { if (!setupObserved) { setupObserved = true; resolveOutcome(result) } }, SETUP_OUTCOME_QUIET_MS)
```

`const result` is in TDZ for the whole duration of lines 535–599.

**Why it is risky.** Note the ordering inside the callback: `setupObserved = true` is set on line 545, *before* the TDZ access on 547. So if ble-plx ever fires that callback synchronously (an immediate error for a device that dropped between discovery and subscribe is the realistic case):

1. `setupObserved` is latched true,
2. the `ReferenceError` escapes into a native callback — not caught by the `catch` at `:623`, which is on a different stack,
3. `resolveOutcome` is never called,
4. the 800 ms optimistic fallback at `:606-611` is **disarmed** by the already-true `setupObserved`,
5. `setupOutcome` never settles.

And the consumer awaits it with no timeout and no race:

```ts
// PunchStream.ts:169
const outcome = await handle.setupOutcome
```

`grep -n "setupOutcome\|Promise.race\|timeout" src/protocol/PunchStream.ts` confirms there is no `Promise.race` and no timeout. The init plan is serial, so ops 6–8 (`mode-normal` 0x01, hand assign, command 17) never execute: the glove sits connected, bonded, silent, with no error logged. That presents identically to the known bonding failure, so it will be misdiagnosed.

**How to confirm/refute.** Read the three line numbers above — the TDZ is visible on inspection. To prove reachability, add a unit test with a fake `BleManager` whose `monitorCharacteristicForDevice` invokes its callback synchronously with an error, and assert `handle.setupOutcome` settles. Also worth checking whether the installed ble-plx fork (`@sfourdrinier/react-native-ble-plx@3.9.3`) can ever invoke synchronously.

**Fix is trivial:** hoist the `const result` declaration above the `manager.monitorCharacteristicForDevice(...)` call.

---

### 9. A missing metronome loop is a silent `return` that also freezes the avatar — and the docstring hides the `baseBpm` dimension

**Severity: MEDIUM**

| | |
|---|---|
| Files | `F:/punchCraft/src/audio/voiceAssets/metronomeAssets.ts:10-11`, `:29-50`, `:51-56`; `F:/punchCraft/src/app/(tabs)/punchcraft/_useWorkoutRunner.ts:1456-1491` |

**What is suspect.** The lookup filters on `baseBpm` first, so the documented fallback is narrower than it reads:

```ts
// metronomeAssets.ts:10-11 (docstring)
 * `metronomeLoopFor(division, swing)` — an exact match wins; else the
 * straight-swing (0.50) loop for that division wins; else undefined.

// :51-56 (code)
export function metronomeLoopFor(division: 1|2|3|4, swing: number, baseBpm = 60): MetronomeLoop | undefined {
  const at = METRONOME_LOOPS.filter((l) => l.baseBpm === baseBpm && l.division === division)
  const exact = at.find((l) => Math.abs(l.swing - swing) < 0.005)
  if (exact) return exact
  return at.find((l) => Math.abs(l.swing - 0.5) < 0.005)
}
```

"the straight-swing loop for that division" is only searched *within the same `baseBpm`*. Rendered pairs are `60×{1,2,3,4}`, `100×{1,2,3}`, `85×{1,2,3}` — there is **no** `baseBpm: 120` loop. A `baseBpm` with no row returns `undefined` with no fallback to 60.

The consumer then silently gives up:

```ts
// _useWorkoutRunner.ts:1468-1475
if (!loop) {
  logger.warn('puncheokie.metronome', 'no loop for tempo', { division, swing, baseBpm })
  return
}
```

**Why it is risky.** `port.start(loop, clickVolume, bpmForRecipe(...))` at `:1490` is what starts **both** the audible loop and the shared logical transport. The comment immediately above it says so explicitly (`:1481-1488`: *"baseBpm from the recipe drives the shared logical transport … clickAudible gates ONLY the loop volume (mute-only): the transport still starts, so the avatar flip and everything else are unchanged"*). So the early `return` skips the transport too — `SharedTransportAnchor` never publishes a running anchor and the avatar flip clock freezes. This is the known bug class that left the avatar frozen on 7 of 11 workouts, and the only signal is one `warn` line in logcat.

Today nothing requests 120 because the 120-BPM maps use `coachTempo {baseBpm: 60, division: 2}`. Any recipe authored with `baseBpm: 120` — the obvious, natural thing to write — trips it.

**How to confirm/refute.** `grep -rln "metronomeLoopFor\|METRONOME_LOOPS" src/ --include=*.test.ts` → **zero**. No test asserts that every shipped sample's `(baseBpm, division, swing)` triple resolves to a loop. Add that test: iterate `allClickMaps()` / `SAMPLES`, call `metronomeLoopFor` for each recipe's `coachTempo`, assert defined. It is ~15 lines and closes the class permanently.

---

### 10. The generator lays blocks at one BPM and the runner re-expands them at another

**Severity: MEDIUM**

| | |
|---|---|
| Files | `F:/punchCraft/src/domain/workout/generateWorkout.ts:122`; `F:/punchCraft/src/app/(tabs)/punchcraft/_useWorkoutRunner.ts:434-439`; `F:/punchCraft/src/domain/workout/cadence.ts:131-136` |

**What is suspect.** Two different tempo seams for the same workout. `generateWorkout` uses the profile's nominal BPM directly; the runner uses `bpmForRecipe`:

```ts
// _useWorkoutRunner.ts:434-439
const bpm = bpmForRecipe(workout.recipe)
const timeline = useMemo(() => expandTimeline(workout, stance, bpm), [workout, stance, bpm])
```

```ts
// cadence.ts:131-136 — bpmForRecipe
metronome.enabled ? coachTempo.baseBpm * coachTempo.division * globalSpeed
                  : CADENCE_PROFILES[cadenceProfile].nominalBpm
```

They agree **only** while `metronome.enabled === false` and `globalSpeed === 1`.

**Why it is risky.** `startOffsetMs` is baked into each block in milliseconds at lay time, while everything *inside* a block (`tokenOffsetsMs`, `blockDurationMs = beatsToMs(maxBeatOffset + gapBeats, bpm)`) is re-derived from beats at the runner's BPM. Change the BPM between the two and block starts stay fixed while block contents stretch or shrink: blocks overrun their neighbours, rounds under-fill, and cues get scheduled past the bell — which is the exact input that triggers target 7's inverted window and target 11's silent drop. The hand-authored samples dodge it by choosing `coachTempo` so `bpmForRecipe === MAP.bpm`; a generated workout with `metronome.enabled: true` has no such protection, and `metronome.enabled` defaults to `false` only in `defaultRecipe()`.

Related: `CueTimeline.ts:310-319` justifies `truncateWindowsAtNextCue` with *"PacingEngine's ±10–15% adjustment (M33-05) does exactly that"* — but `PacingEngine` cannot currently re-expand anything (the timeline is `useMemo`'d on `[workout, stance, bpm]` and `expandTimeline` is never re-run mid-session; only `decision.cueText` is consumed). So the rationale describes a path that cannot fire, while the real re-expansion risk is this generator/runner mismatch, which is undocumented.

**How to confirm/refute.** `generateWorkout({...defaultRecipe(), metronome: {enabled: true, volume: 0.6}})`, then `expandTimeline(workout, 'orthodox', bpmForRecipe(workout.recipe))`, and assert every block satisfies `startOffsetMs + durationMs <= workDurationMs` and that windows are non-inverted. Also run `validateGeneratedWorkout` — note it checks `block-overruns-round` against the *lay-time* durations, so it will pass while the re-expanded timeline is broken.

---

### 11. A subscribe error arriving after the 800 ms quiet window is discarded entirely

**Severity: MEDIUM**

| | |
|---|---|
| Files | `F:/punchCraft/src/ble/BleManagerBlePlxImpl.ts:544-558`, `:600-611`, `:156` (`SETUP_OUTCOME_QUIET_MS = 800`) |

**What is suspect.** All failure recording is inside the one-shot `if (!setupObserved)` branch:

```ts
544:  if (!setupObserved) {
545:    setupObserved = true
546:    if (err) {
547:      result.success = false
548:      result.errorMessage = err.message
549:      resolveOutcome(result)
550:      return
551:    }
552:    resolveOutcome(result)          // first callback carried data → confirmed
553:  }
554:
555:  if (err) return                    // every LATER error: dropped on the floor
```

Once the `setTimeout` at `:606` settles optimistically (`success: true`), any subsequent error callback hits line 555 and vanishes — not logged, not recorded on `result`, not surfaced to `setupOutcome` (already resolved) nor to `handle.result` (same object, but nobody re-reads it).

**Why it is risky.** `BleManagerFacade.ts` documents `setupOutcome` as *the* definitive signal, and `PunchStream.ts:160-163` relies on it: *"Silent failures show up here, not on the sync result."* For the data-stream characteristic `ca281069` (indication) an 800 ms quiet window is entirely normal — a still athlete produces no frames — so the optimistic path is the *common* path, and a CCCD failure landing at t+900 ms is invisible. The result is a connected, "successfully initialised" glove that never delivers a punch, with `initErrors` empty.

Secondary: `result` is a single mutable object shared by `handle.result`, both `resolveOutcome` paths, and the late-mutation at `:547-548`. Even if a late error *did* mutate it, no consumer re-reads.

**How to confirm/refute.** Fake manager whose monitor callback fires an error at 1000 ms. Assert that `initErrors` contains an entry and that something was logged. Expect both to be empty. The fix is to keep a post-settle error path that logs and records (a `logger.warn('ble.subscribe.lateError', …)` at minimum).

---

### 12. `firmwareVersion` is never read from the device and self-pins to `4` on the first frame — the whole v<4 decode path is unreachable dead code

**Severity: MEDIUM**

| | |
|---|---|
| Files | `F:/punchCraft/src/protocol/PunchStream.ts:72`, `:95`; `F:/punchCraft/src/protocol/fightcamp-v1/FightCampV1Adapter.ts:47`, `:201-228`; `F:/punchCraft/src/protocol/fightcamp-v1/FightCampV1Decoder.ts:100`; `F:/punchCraft/src/protocol/fightcamp-v1/FightCampV1State.ts:42` |

**What is suspect.** The state is seeded with no firmware field and is then overwritten by the adapter's own default:

```ts
// PunchStream.ts:72
let state: ProtocolState = { connectionGeneration: 0 }
// :95 (inside onFrame)
state = result.newState
```

```ts
// FightCampV1Adapter.ts:205-218
const firmwareMajorVersion =
  typeof state.firmwareVersion === 'number' ? state.firmwareVersion : DEFAULT_FIRMWARE_MAJOR_VERSION  // = 4
...
const newState: ProtocolState = { ...state, firmwareVersion: firmwareMajorVersion, ... }
```

So frame 1 reads `undefined` → defaults to 4 → writes `firmwareVersion: 4` back into state → every later frame reads 4. Self-fulfilling. `grep -rn "firmwareMajorVersion\|firmwareVersion" src/` confirms **no writer** anywhere other than this echo-back. The record-width switch is therefore constant:

```ts
// FightCampV1Decoder.ts:100
const recordWidth = state.firmwareMajorVersion >= 4 ? 9 : 13
```

**Why it is risky.** Three things follow. (a) The 13-byte legacy layout (`Decoder.ts:294-323`) is unreachable in production — dead code that a reviewer will read as a live path, including its *different* velocity rule (plain `raw/2`, no piecewise, no ×1.7). (b) `FightCampV1State.parseFirmwareMajor()` and `INITIAL_STATE` (`:42`) have zero production callers. (c) A genuine v<4 tracker would be decoded with the wrong record width and produce garbage flagged `malformed` — with no diagnostic pointing at firmware. The init plan reads `ca281070` (which is **not** device info — see target 15's note) and never reads the `0x180a` Software Revision String that H11 says carries the version.

**How to confirm/refute.** `grep -rn "firmwareVersion" src/ | grep -v "__tests__"` — every hit is a read or the echo. Then confirm `FightCampV1State.ts:42`'s `INITIAL_STATE` has no importer outside tests.

---

### 13. "The click vocabulary is snapshotted per round" — the code 1,580 lines below does the opposite

**Severity: MEDIUM**

| | |
|---|---|
| Files | `F:/punchCraft/src/app/(tabs)/punchcraft/_useWorkoutRunner.ts:668-677` vs `:2251-2270` |

**What is suspect.** The declaration comment states a rule:

```ts
// :668-673
/**
 * The click-script vocabulary, snapshotted per round: schedules compile
 * with the vocabulary current at round start, so a mid-round radio flip
 * applies from the following round — same precedent as the announcer's
 * placement margins. Numbers fallback lives in findClickScript itself.
 */
const clickVocabularyRef = useRef<'numbers' | 'techniques'>(...)
```

`setVocabulary` does the exact opposite, and says so:

```ts
// :2251-2270
setVocabulary: (vocabulary) => {
  if (clickVocabularyRef.current === vocabulary) return
  announcerRef.current?.setVocabulary(vocabulary)
  clickVocabularyRef.current = vocabulary
  // MID-SET flip (Kyle 2026-09-04: "switched it to technique and it's
  // still running on numeric a whole minute later"): rebuild the
  // CURRENT round's schedule in the new vocabulary, then retire
  // everything already in the past so nothing back-fires ...
  const snapshot = sessionRef.current?.snapshot()
  if (!snapshot || snapshot.phase !== 'work') return
  buildLeadInSchedule(snapshot.roundIndex)
  ...
}
```

**Why it is risky.** The stale comment is the *first* thing a reader encounters, it is repeated in the project memory notes, and it describes the behaviour Kyle explicitly filed a complaint about. Anyone "restoring" the documented snapshot semantics re-introduces the 2026-09-04 bug.

There is also a real side effect nobody is likely to notice: `buildLeadInSchedule` reassigns `maskedCueIdsRef.current` at `:802`, so a mid-round vocabulary flip also re-derives which bars are visually masked, mid-round. And the retirement loop marks `entry.state = 'skipped'` for `dispatchAtMs <= workElapsedMs` on a *freshly rebuilt* schedule, so a lead-in that was mid-flight is silently retired rather than resumed.

**How to confirm/refute.** Read the two blocks. Then check for a test: there is none asserting mid-round flip behaviour either way.

---

### 14. `RoundTimeline.deferredBlockIds` is documented as "deliberately not silent" and has zero production consumers

**Severity: MEDIUM**

| | |
|---|---|
| Files | `F:/punchCraft/src/domain/programs/CueTimeline.ts:165-174`, `:248`; `F:/punchCraft/src/domain/workout/WorkoutTokens.ts:75-94` |

**What is suspect.** The field's own doc comment:

```ts
// CueTimeline.ts:169-174
 * Additive to the binding interface, and deliberately not silent: these
 * blocks are a large share of the authored samples, so dropping them
 * without a trace would make the live screen look broken rather than
 * incomplete.
 */
deferredBlockIds: string[]
```

`grep -rn "deferredBlockIds" src/ --include=*.ts --include=*.tsx | grep -v CueTimeline.ts` returns **only four test-file hits**, and three of them assert the array is *empty*:

- `src/domain/programs/__tests__/countScoredCues.test.ts:169` → `toEqual([])`
- `src/domain/programs/__tests__/CueTimeline.test.ts:147` → `toEqual([])`
- `CueEngine.test.ts:116`, `CueAnnouncer.test.ts:1496` → fixture literals `[]`

No UI reads it, no logger reports it, no validator fails on it.

**Why it is risky.** `BlockKind` has 10 members (`WorkoutTokens.ts:75-94`) and only 8 are routed — `SEQUENCE_KINDS` (`CueTimeline.ts:178-183`) ∪ `COUNT_SCORED_KINDS` (`:190-199`). A `'sustained-strike'` block is therefore **silently dropped from the timeline**: not displayed, not scored, not announced, not logged. The tests that "cover" the field actively enforce that this path is never exercised, which is the worst kind of coverage — it looks green and guarantees the mechanism is untested.

Note the related inconsistency a reviewer should flag at the same time: `goalAllocation.ts:48` defines its **own** `COUNT_SCORED_KINDS` = `{volume-burst, open-pressure, coast}`, omitting `active-recovery`, which `CueTimeline`'s set includes. Two divergent definitions of the same concept in one domain.

**How to confirm/refute.** Expand a workout containing one `'sustained-strike'` block and observe it appears in `deferredBlockIds` and nowhere else. Decide: either consume the field (one `logger.warn` in the runner's round setup is enough) or delete it and make the unrouted kinds a validation error.

---

### 15. `cueScoring`'s `aggregateScores` is uncalled, and reconstructs counts from percentages using the **wrong denominator**

**Severity: MEDIUM**

| | |
|---|---|
| Files | `F:/punchCraft/src/domain/programs/cueScoring.ts:110-113`, `:155-170`, `:236-258` |

**What is suspect.** `scoreCue` computes `correctHandPct` over *answered* punches, and documents the choice at length:

```ts
// cueScoring.ts:159-165
// Accuracy among the punches that actually answered an expectation, not
// among the punches the cue called. A set half-thrown with the right hand
// scores 100% here and 50% on completion, which is the honest reading ...
correctHandPct: pct(correctHand, correctHand + wrongHand),
```

`aggregateScores` then inverts that percentage against a **different** denominator:

```ts
// cueScoring.ts:241-247
for (const score of scores) {
  expected += score.expectedCount
  const cueLanded = Math.round((score.completionPct / 100) * score.expectedCount)
  landed += cueLanded
  correctHand += Math.round((score.correctHandPct / 100) * score.expectedCount)   // <-- wrong base
  onTime += Math.round((score.timingWindowPct / 100) * cueLanded)
  extras += score.extraCount
}
```

**Why it is risky.** Worked example, two 4-punch cues:

- Cue A: 4 landed, 4 correct hand, 0 wrong → `correctHandPct = pct(4,4) = 100`
- Cue B: 1 landed, 0 correct hand, 1 wrong → `correctHandPct = pct(0,1) = 0`

Aggregate: `expected = 8`; `correctHand = round(1.00×4) + round(0.00×4) = 4`; reported `correctHandPct = pct(4, 8) = 50%`. The honest figure (4 correct of 5 answered) is **80%**. A 30-point error, and `correctHand` can even exceed `landed`, which is an impossible state.

Severity is held at MEDIUM only because the function is **dead**: `grep -rn "aggregateScores" src/ tools/` returns **nothing** — no production caller and no test. Likewise `timingWindowPct` is computed at `:164` and `:254` and consumed nowhere outside this file, even though doc D20 (`docs/design-spec.md`) states that timing is no longer scored and `timingWindowPct` is retired. So the module carries a buggy, undocumented-as-dead metric that contradicts the design spec.

The structural smell is worth naming independently of the bug: round-tripping counts through a lossy percentage (`pct` rounds to one decimal, `:110-113`) instead of carrying the counts. It happens to be lossless at current cue sizes, but any "cleanup" of `pct` to integer percent silently corrupts every aggregate.

**How to confirm/refute.** `grep -rn "aggregateScores" src/ tools/` → empty. Then paste the two-cue example into a scratch test. Decide: delete `aggregateScores` + `timingWindowPct` (aligning with D20), or fix the denominator and sum real counts instead of inverting percentages.

---

### 16. `handAtCapture` is stamped only on an in-memory copy and is never persisted — hand attribution is unreproducible from storage or from the one committed fixture

**Severity: MEDIUM**

| | |
|---|---|
| Files | `F:/punchCraft/src/protocol/PunchStream.ts:74-75`; `F:/punchCraft/src/ble/BleManagerBlePlxImpl.ts:570-596`; `F:/punchCraft/src/protocol/fightcamp-v1/fixtures/spike-mt4wm1d8-fx6x.json` |

**What is suspect.** The transport builds the frame with `handAtCapture: 'unknown'` (`BleManagerBlePlxImpl.ts:574`), persists *that* frame (`:593`, `this.frameSink?.capture(frame)`), and only then delivers it (`:596`). `PunchStream` stamps the hand onto a **copy**:

```ts
// PunchStream.ts:74-75
const onFrame = (frame: RawBleFrame): void => {
  const stampedFrame: RawBleFrame = { ...frame, handAtCapture: hand as Hand }
```

Verified: `grep -rn "hand_at_capture\|handAtCapture" src/storage/` returns **nothing** — `ble_frames` has no such column at all. The only hand in the schema is `tracker_devices.assigned_hand` (`001_initial.ts:22`, `DEFAULT 'unknown'`).

**Why it is risky.** Per H11, hand is **never in the payload** — it is pure out-of-band metadata derived from the MAC via `KNOWN_TRACKERS` (`src/ble/knownTrackers.ts:32-35`). The persist-before-parse rule (CLAUDE.md §1, §11.9, §12.4) is honoured for the bytes, but the one field that cannot be recovered from the bytes is dropped on the floor. `FightCampV1Decoder.ts:139` forwards `frame.handAtCapture` as the event's hand, so replaying stored frames yields events with `hand: 'unknown'`, and `CueMatcher.outcomeFor` / `LiveCueMatcher`'s `event.hand !== expected.hand` check (`LiveCueMatcher.ts:270`) will report hand mismatches for every punch.

The committed fixture is no better — verified by reading it: keys are `['runId','capturedAt','deviceId','notes','serviceUuid','characteristicUuid','records']`, 21 records, and `records.some(r => 'handAtCapture' in r || 'hand' in r)` is `false`. This directly undercuts CLAUDE.md §21's requirement that the replay harness reproduce confirmed captures on Windows without hardware.

**How to confirm/refute.** `grep -rn "handAtCapture" src/ --include=*.ts` — note the transport writes `'unknown'`, `PunchStream` spreads into a copy, and storage never sees the field. Then decode the committed fixture and inspect `events[].hand`.

---

### 17. The 20 s tracker heartbeat has no re-entrancy guard

**Severity: MEDIUM**

| | |
|---|---|
| Files | `F:/punchCraft/src/protocol/trackerKeepalive.ts:55`, `:119-146`, `:172-174` |

**What is suspect.** An async function fired from a bare interval:

```ts
// trackerKeepalive.ts:172-174
heartbeat = setInterval(() => {
  void heartbeatTick()
}, HEARTBEAT_INTERVAL_MS)      // 20_000
```

`heartbeatTick` (`:119-146`) loops over both gloves **serially**, awaiting three BLE round-trips each: `facade.isConnected`, `facade.writeCharacteristic(..., withResponse = true)`, and `readBattery` (another read). Nothing tracks whether a previous tick is still in flight.

**Why it is risky.** A write-with-response on a flaky LE link can block for tens of seconds (GATT-level timeouts are typically ~30 s). Six serialized BLE ops across two links can exceed 20 s under load, after which ticks overlap and pile up — each one writing mode-normal to both gloves. Two consequences:

1. Overlapping BLE operations on the same link are the H04 / "second glove always dies" failure class that `autoConnectTrackers` goes to great lengths to avoid by connecting strictly serially. The keepalive reintroduces concurrency on the *same* links.
2. A mode-normal write is the **buffer-drain trigger**, so duplicated writes can trigger overlapping drains, producing interleaved backfilled records — which feed straight into target 6.

Also: `getBleManager()` at `:120` is outside the per-tracker `try`, so if it throws, `void heartbeatTick()` produces an unhandled rejection with no log.

**How to confirm/refute.** Read `:119-146` and `:172-174`. Confirm no `let inFlight` / promise-chaining guard anywhere in the file (`grep -n "inFlight\|running\|busy" src/protocol/trackerKeepalive.ts`). Fix is a 3-line boolean guard plus moving `getBleManager()` inside a try.

---

### 18. `persistWorkoutSession` drops `velocityCalibrated`, so `punch_events` and `cue_results` disagree about the same punch

**Severity: LOW-MEDIUM**

| | |
|---|---|
| Files | `F:/punchCraft/src/storage/persistWorkoutSession.ts:141-169`; `F:/punchCraft/src/storage/cueResultRows.ts:74`; `F:/punchCraft/src/storage/migrations/002_punch_events.ts:56` |

**What is suspect.** The `appendPunchEvent` call spreads nine optional fields and omits one:

```ts
// persistWorkoutSession.ts:157-169 (excerpt)
...(event.punchTypeRaw !== undefined ? { punchTypeRaw: event.punchTypeRaw } : {}),
...(event.punchType !== undefined ? { punchType: event.punchType } : {}),
...(event.accelerationRaw !== undefined ? { accelerationRaw: event.accelerationRaw } : {}),
...(event.velocityRaw !== undefined ? { velocityRaw: event.velocityRaw } : {}),
velocityUnit: event.velocityUnit,
// velocityCalibrated: ABSENT
```

The column exists (`002_punch_events.ts:56`, `velocity_calibrated REAL`) and the parallel path writes it (`cueResultRows.ts:74`, `velocityCalibrated: event?.velocityCalibrated ?? null`).

**Why it is risky.** `punch_events.velocity_calibrated` is NULL for every workout-persisted punch while `cue_results.velocity_calibrated` is populated for the same punch — so any query joining the two, or any analysis reading from `punch_events`, silently sees no calibrated velocity for punchCraft sessions but does for Velocity Lab captures (which persist via `BleCaptureService.recordEvent`, wired only at `src/app/(tabs)/velocity-lab/live.tsx:127`).

Worth reviewing alongside the adjacent, larger gap: decoded punch events are **not** persisted at all during a punchCraft workout — `PunchStream.onEventPersist` is wired in that one Velocity Lab call site only, so workout punches reach `punch_events` solely via `persistWorkoutSession`, and only the subset that cue results actually *name* (`matchedEventsRef`, `_useWorkoutRunner.ts:1344`). Unmatched punches and extras are never stored as events.

**How to confirm/refute.** Diff the field lists of `persistWorkoutSession.ts:143-169` against `cueResultRows.ts:65-80`. One-line fix; the value is mostly in flagging that nothing tests round-trip field parity between the two writers.

---

## Explicitly refuted (do not spend time here)

- **`compiledAtEpochMs` does not pollute `timelineHash`.** The runner passes `Date.now()` into `compileWorkoutScore` (`_useWorkoutRunner.ts:1779`), which looks like it would make the content hash non-deterministic. It does not: `workoutScore.ts:62` imports `hashTimelineContent` and the hash is a content-address of strikes + `phaseBoundaries` only (`:143-147`); `compiledAtEpochMs` is a sibling field on `CompiledWorkoutScore` (`:283`). The hash is deterministic.
- **The `audibleUntilMs() > 0` call sites are not *currently* broken.** `VoiceOutputExpo.audibleUntilMs()` (`:798-801`) normalises a past deadline to `0` internally, so the six consumers behave correctly today. The finding in target 2 is the *contract* mismatch and the fragility, not a live misbehaviour — do not report it as an active audio bug.
- **`percentage → count` reconstruction in `aggregateScores` is not currently lossy.** `pct` keeps one decimal (`cueScoring.ts:110-113`), giving relative error ≤5e-4, which at realistic `expectedCount` (≤12) stays well under 0.5. The bug in target 15 is the **wrong denominator**, not the rounding.

## Suggested review order

Targets **1, 2, 3** are the ones where a well-intentioned cleanup does the most damage, and all three are confirmable by reading fewer than 30 lines each — start there. **4** and **5** are the two places where the test suite and the tooling actively assert a false invariant, so they compound every future timing or voice change. **6, 7, 8** are the genuine latent defects most likely to be hit by normal use.


## Open questions

- Is `scoreDispatchEnabled` (voiceMode !== 'minimal') intended to be permanently false, or is the V2 score path meant to ship? If the former, SlotDispatcher.ts, comboAnnounceManifest.ts (218 clips), coachAssetResolvers.ts and the `shouldSpeak` gate at _useWorkoutRunner.ts:1804 should be marked dormant in-file, because a reviewer currently cannot tell which of the two coach paths is authoritative.
