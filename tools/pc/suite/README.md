# The PC suite

The tablet's verify suite, on this machine, with no tablet attached. It
drives each sample workout in a headless browser, has the tablet's own
correlator judge every round of it, listens to what the page plays, watches
the rings, and compares what was said with what a native build said.

Its sibling is `npm run emu:suite` — the same suite on a native Android
build in an emulator, which is where the tablet's tests are run
(`docs/dev-setup.md`, "An Android emulator").

```
npm run pc:suite                      all 22 workouts, round 1 and its rest — about 22 minutes
npm run pc:suite -- --only quick-one-two,body-work
npm run pc:suite -- --vocab techniques        (or both)
npm run pc:suite -- --full                    whole workouts, every round judged — 10 to 20 minutes each
npm run pc:parity                     the newest run against the device reference
```

A run lands in `tools/pc/suite/runs/<date>/` (git-ignored): `summary.md`,
`parity.md`, and a folder per workout with its capture (`logcat.txt`),
`sound-report.md`, `rings-report.json` and `drive.json`.

## What a drive covers

Round 1 and the rest after it, ending at the bell that opens round 2. That
is one of everything the coach does: the intro, a round of calls, the bell,
the rest line, the countdown, and the next bell. `--full` runs the workout
to its last bell; all 22 that way, in both vocabularies, took an hour and 52
minutes on 16 processors.

## What it checks

**The correlator.** `tools/analysis/verify-first-round.mjs`, the tablet's own,
on a capture written in the tablet's `logcat.txt` layout against the same
manifest. A manifest holds every round, and each round the capture holds
whole is judged against its own part: a lead-in missing, extra or late (by
name and time); how many calls were sent against how many the runner plans;
a clip that would not load.

The suite tells it how far the drive was meant to run — round 1 for the
default drive, every round for `--full` — and a round that was meant to be
driven and is not whole in the capture **fails** the drive. So checking
every round cannot quietly become checking fewer. The summary shows it:
`matched=6 extras=0 reanchor=0 · 2 of 2 rounds · 3 of 3 ceremonies`.

**The ceremonies.** The walkout, each rest's line and each countdown are
native playlists the app builds ahead of time and logs as it builds them.
The manifest says what each line should read — how many tracks, how long,
which script — and the correlator holds the capture to it, and to the
ceremony having started. A countdown opens with one of fifteen lines picked
at random; the app logs which, and its length is checked less that opener.
A line that reads wrong fails. A ceremony with no line at all fails here,
where a capture loses nothing, and only warns on a device, whose log drops
lines. (Whether it was *heard* is the next check.)

**The sound.** Every clip the page plays is routed through a measuring point
inside the browser, which notes when its sound starts and stops. A drive
fails when:

- a call or lead-in was played at full volume and made no sound;
- a clip was stopped more than 150 ms before its end, and nothing accounts
  for the stop;
- a call was still sounding when the ring it leads was due;
- a round start, a round end or the finish had no bell, or its bell made no
  sound or was stopped;
- the intro, a countdown or a rest line did not play as the app said it
  would — a clip of it silent, one stopped for no reason the app logged, or
  fewer clips than the app loaded;
- the app itself logged a clip it could not play or could not find, in any
  round.

It warns when:

- more than 2% of calls stop under the 150 ms floor before their ring;
- the bell cut the countdown, the round began over the intro, or the rest
  ended over the rest line — the app stopped it while it was still sounding;
- the rest line was still sounding when the countdown began;
- one ceremony played its clips at different volumes;
- the measuring point did not start, or could not listen to an element.

The 150 ms allowance, the 150 ms floor and the 2% are the tablet gate's own,
read from where it keeps them. Each drive's `sound-report.md` has the
detail, round by round on a whole workout; `--record` also keeps what the
page played as `sound.webm`.

_Stopped short is not yet cut._ The app stops some clips itself and logs
that it did — the countdown, when the bell rings. A run ends while something
is still playing. A first-time clip leaves an empty audio element behind. So
every stop is given a reason: the clip ended, the app stopped it, the run
ended, the element was played again, the element reported an error. Only a
stop with no reason, or a replay over a clip still sounding, is a cut.

_Reported, not judged:_ how long after its moment a bell sounds, and the gap
from the countdown's last word to the bell. The tablet aims that gap at 0 to
400 ms by the playhead; heard sound ends 60 to 150 ms before a file does, so
a PC sits on the upper edge of that by construction.

**The rings.** From the app's own records of what it scheduled and what it
painted (`tools/analysis/rings.mjs`, which the emulator suite uses too). A
drive fails when a bar the app scheduled did not light all its rings. It
warns when a ring was painted more than 100 ms after its scheduled time,
when a late frame stepped over a ring, when the app's 50 ms loop stalled and
caught up, and when the ring clock ran more than 20 ms apart from the session
clock. The 100 ms and the 20 ms are this check's own numbers, not tablet
constants. The rings cannot light out of order — the code only moves forward
within a bar — so that is not a rule.

A ring is timed by the frame that painted it against the SESSION clock's
schedule, which is the one the calls keep. The ring clock is the UI
thread's copy, and judged against itself it cannot see the two drifting
apart (N-18 read 2.8 ms late that way, and was 35). Rings on bars the app
keeps dim on purpose — a bar with no call, and the first two measures of a
round — are counted apart from rings that were shown lit.

**The page.** Any error on the page fails the drive — the smoke test's rule.

**Parity.** `pc:parity` compares each workout with the device reference in
`device-reference/`, in every round both hold whole: which clip, its words,
when it was due, how long it is, and when the ring it leads is due must
match dispatch for dispatch. Lateness is shown side by side, each figure
under the name of the device it is from, and never compared.

## What it cannot tell you

- How long sound takes to leave the tablet's speaker, or the tablet's own
  start latency. The sound is measured where it enters the browser's mixer.
- Whether the tablet's processor keeps up. Every lateness figure here is this
  PC's.
- Whether each call was the right call. A round's lead-ins are checked by
  name and time; its calls only by how many were sent.
- Which line a rest plays when no script was authored for it. All 41 rests
  in the samples have one; the seeded walkthrough behind them has no
  expectation and is reported as not checked.
- Anything that happens when the athlete leaves the screen. A drive ends on
  the workout's last boundary and stays put.
- Anything by ear.

**No tablet timing constant is ever set from a number in these reports.**
`tools/analysis/observed-timing.mjs`, the tablet's timing analyzer, refuses a
capture from here: every onset in it is corrected by the tablet's measured
start latency, and every constant it proposes is the tablet's.

The app's own playback observer does run here, with a reading of a browser's
player statuses of its own (`src/audio/observedStatus.web.ts`). Each drive's
`sound-report.md` ends with it held against the audio elements — when each
says a clip began and ended — and `summary.md` gives the furthest apart the
two were. That is a report, not a gate.

## Proving the gate

A gate only ever seen to pass has not been shown to work. `--fault` breaks
the app on purpose while the app goes on believing all is well, so only the
rule it is aimed at can fail the drive:

```
npm run pc:suite -- --only quick-one-two --fault mute            a call that makes no sound
npm run pc:suite -- --only quick-one-two --fault cut             a call stopped part-way
npm run pc:suite -- --only quick-one-two --fault late            a call that runs into its ring
npm run pc:suite -- --only quick-one-two --fault mute-bell       a bell that makes no sound
npm run pc:suite -- --only quick-one-two --fault cut-countdown   a countdown stopped part-way, unlogged
npm run pc:suite -- --only quick-one-two --fault late-rings      the screen's frames held back; the sound untouched
```

Each must FAIL, on its own rule. `late-rings` holds back animation frames
only: stalling the whole page would delay the calls with the rings and prove
nothing about either.

## The device reference

`device-reference/*.json` is each workout as a native build's suite captures
recorded it — every round the capture holds whole — with the device, build
and date it came from. After a suite run on the tablet or the emulator,
rebuild it:

```
npm run pc:parity -- --build-reference tools/analysis/suites/<the run>
```

A reference says which device wrote it: `tablet` or `emulator`. What is said
and when it is due is the same code on both, so either will do for that.
The lateness beside it will not — an emulator on this PC is a PC — so a
reference built from an emulator run keeps the tablet's own lateness from
the file it replaces, under the date it was taken, and the report shows
both. A PC capture is refused: the reference is what the PC is compared
with. A file written before references held every round (`round1`, no
`rounds`) still reads, as round 1.

Parity **skips** a workout, with a note, when its timeline or one of its
clips has changed since the device capture: a re-recorded clip is a different
length, so it is sent at a different time. A skipped workout is not compared
at all. As of 2026-11-28 none is: the reference was rebuilt from an emulator
run of all 22 in both vocabularies, at the commit that changed nothing they
play. Ten of the 22 had been skipped since four call clips were re-recorded
after the tablet's September capture. The next re-recording skips its
workouts again until a device suite runs.

A device's log drops lines under load. A PC run that holds everything the
device's capture holds, in order, plus one or two dispatches more over the
whole workout, is read as the same with lines lost, and the report says so.

## Running it

- **It builds first.** The build replaces `dist/pc-app/`, so do not start a
  second run, `pc:app` or `pc:smoke` while one is going. `--no-build` serves
  the build already there; a drive warns if that build is not the checkout's
  commit.
- **Several at once.** `--jobs N`; by default half the machine's processors,
  six at most. Measured on 16 processors: six at once reads the same as one
  alone. More has not been measured.
- **Keep the machine quiet** if the timing figures matter. Running the test
  suite alongside puts every processor to work, and the lateness columns
  will show it.
- `--sound-gate warn` turns a sound failure into a warning; `off` reports and
  judges nothing. `--no-sound` does not listen at all.

Exit codes are the tablet suite's: 0 all passed, 2 a warning, 1 a failure or
a drive that broke, 4 a manifest that no longer matches the build.
