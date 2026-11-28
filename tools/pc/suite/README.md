# The PC suite

The tablet's verify suite, on this machine, with no tablet attached. It
drives each sample workout in a headless browser, has the tablet's own
correlator judge it, listens to what the page plays, watches the rings, and
compares what was said with what the tablet said.

```
npm run pc:suite                      all 22 workouts, round 1 and its rest — about 22 minutes
npm run pc:suite -- --only quick-one-two,body-work
npm run pc:suite -- --vocab techniques        (or both)
npm run pc:suite -- --full                    whole workouts — 10 to 20 minutes each
npm run pc:parity                     the newest run against the tablet
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

**The correlator.** `tools/analysis/verify-first-round.mjs`, unchanged, on a
capture written in the tablet's `logcat.txt` layout against the same
manifest. A coach line missing, extra or late; a call not dispatched; a
clip that would not load. It reads round 1 and nothing after it.

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
painted. A drive fails when a bar the app scheduled did not light all its
rings. It warns when a ring was painted more than 100 ms after its scheduled
time, when a late frame stepped over a ring, and when the app's 50 ms loop
stalled and caught up. The 100 ms is this suite's own number, not a tablet
constant. The rings cannot light out of order — the code only moves forward
within a bar — so that is not a rule.

**The page.** Any error on the page fails the drive — the smoke test's rule.

**Parity.** `pc:parity` compares round 1 of each workout with the tablet
reference in `tablet-reference/`: which clip, its words, when it was due,
how long it is, and when the ring it leads is due must match dispatch for
dispatch. Lateness is shown side by side and never compared.

## What it cannot tell you

- How long sound takes to leave the tablet's speaker, or the tablet's own
  start latency. The sound is measured where it enters the browser's mixer.
- Whether the tablet's processor keeps up. Every lateness figure here is this
  PC's.
- Whether rounds after the first say what they were meant to. The correlator
  and its manifests cover round 1. In later rounds the suite judges what the
  app played — that it sounded, whole, clear of its ring — and nothing says
  what it should have played.
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

## The tablet reference

`tablet-reference/*.json` is round 1 of each workout as a tablet suite's
captures recorded it, with the build and date it came from. After a tablet
suite run, rebuild it:

```
npm run pc:parity -- --build-reference tools/analysis/suites/<the tablet run>
```

Parity **skips** a workout, with a note, when its timeline or one of its
clips has changed since the tablet capture: a re-recorded clip is a different
length, so it is sent at a different time. A skipped workout is not compared
at all. As of 2026-11-26 ten of the 22 are skipped — four call clips were
re-recorded after the September capture — and stay so until the tablet suite
runs again.

The tablet's log drops lines under load. A PC run that holds everything the
tablet's capture holds, in order, plus one or two dispatches more, is read as
the same with lines lost, and the report says so.

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
