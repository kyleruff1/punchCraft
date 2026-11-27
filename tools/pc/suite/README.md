# The PC suite

The tablet's verify suite, on this machine, with no tablet attached. It
drives each sample workout in a headless browser, has the tablet's own
correlator judge it, listens to what the page plays, and compares what was
said with what the tablet said.

```
npm run pc:suite                      all 22 workouts, round 1 — about 20 minutes
npm run pc:suite -- --only quick-one-two,body-work
npm run pc:suite -- --vocab techniques        (or both)
npm run pc:suite -- --full                    whole workouts, not round 1
npm run pc:parity                     the newest run against the tablet
```

A run lands in `tools/pc/suite/runs/<date>/` (git-ignored): `summary.md`,
`parity.md`, and a folder per workout with its capture and reports.

## What it checks

**The correlator.** `tools/analysis/verify-first-round.mjs`, unchanged, on a
capture written in the tablet's `logcat.txt` layout against the same
manifest. A coach line missing, extra or late; a call not dispatched; a
clip that would not load.

**The sound.** Every clip the page plays is routed through a measuring point
inside the browser, which notes when its sound starts and stops. A drive
fails when:

- a call or lead-in was played at full volume and made no sound;
- a clip was stopped more than 150 ms before its end;
- a call was still sounding when the ring it leads was due.

It warns when more than 2% of calls stop under the 150 ms floor before their
ring. Both numbers are the tablet gate's own, read from where it keeps them.
Each drive's `sound-report.md` has the detail; `--record` also keeps what the
page played as `sound.webm`.

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
- Anything by ear.

**No tablet timing constant is ever set from a number in these reports.**
`tools/analysis/observed-timing.mjs`, the tablet's timing analyzer, refuses a
capture from here: its figures rest on the tablet's measured start latency,
and in a browser the app's playback observer reports "started" the moment
play is requested.

## Proving the gate

A gate only ever seen to pass has not been shown to work. `--fault` breaks
the app on purpose while the app goes on believing it played every clip, so
only the sound gate can fail the drive:

```
npm run pc:suite -- --only quick-one-two --fault mute    a call that makes no sound
npm run pc:suite -- --only quick-one-two --fault cut     a call stopped part-way
npm run pc:suite -- --only quick-one-two --fault late    a call that runs into its ring
```

Each must FAIL, on its own rule.

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
