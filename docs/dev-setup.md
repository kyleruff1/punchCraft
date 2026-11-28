# Development setup

Windows 11 workstation + a physical Android tablet. The tablet is the BLE central; the emulator is not a substitute for physical tracker validation (§11.1).

## Workstation

- Windows 11 Home 10.0.26200
- Git 2.54.0 (Git Bash), PowerShell 5.1 for interactive terminal work
- Node 24.15.0, npm 11.12.1, npx 11.12.1
- JDK 17 (Microsoft OpenJDK 17.0.20 at `C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot`, `JAVA_HOME` set)
- Android SDK at `C:\Users\kyler\android-sdk`
  - Platform: `android-35` (installed)
  - Build-tools: `34.0.0` (installed)
  - NDK: `27.2.12479018` (installed)
  - Cmdline-tools: `latest` (installed)
  - **Expo SDK 57 will need newer components (expected platform 36, build-tools 36.x). Install after Story 1 locks the SDK** — see the sdkmanager section below.
- `adb` from platform-tools, ADB debug over USB enabled on the tablet.
- `gh` 2.92.0 authenticated as `kyleruff1` with scopes `gist, project, read:org, repo, workflow`.
- Netlify CLI 27 and Claude Code 2.1 are installed globally but not required for this project.
- **ffmpeg 9.0** (`winget install --id Gyan.FFmpeg`) — required only to
  *regenerate* Voice Coach clips, not to build or run the app. The generated
  clips are committed, so a fresh checkout needs ffmpeg only if the voice
  changes.

  winget installs it without refreshing the current shell's `PATH`, so a new
  terminal is needed before `ffmpeg` resolves by name.
  `tools/voice/make-phrase-clips.mjs` looks in both places and fails with the
  install command rather than silently skipping post-processing.

## Repository identity

Git has no `~/.gitconfig` on this workstation; identity is set per-repository:

```bash
git config user.name "Kyle Ruff"
git config user.email "49955853+kyleruff1@users.noreply.github.com"
git config core.autocrlf false
```

Using the GitHub noreply email avoids the GH007 "your push would publish a private email" rejection when pushing to a private repo.

## Android tablet

Sprint 1 M01 records the specific tablet: model, Android release, API level, chipset, Bluetooth chipset/version. Fill this in when the tablet is attached:

- Model: **TBD (M01)**
- Android release / API: **TBD**
- Bluetooth chipset: **TBD**
- Serial (adb): **TBD**

Enable Developer Options → USB debugging, then verify:

```bash
adb devices -l
```

## An Android emulator, when there is no tablet

A release build of the app runs in an Android emulator on this PC. First
done 2026-11-27.

**What it is good for:** the app's native path with nothing attached —
Hermes, the UI-thread ring clock, the native audio players, expo-sqlite and
its migrations, the QA deep link, and the tablet's own verify suite.

**What it is not:** the tablet.

- No gloves. It has no Bluetooth; the app asks for the permission twice
  (at launch and on the live screen) and the second prompt holds the workout
  until it is answered. Decline both.
- **Every timing figure from it is a PC number.** Its processor and audio
  path are this PC's, and no tablet constant is set from an emulator. The
  tooling enforces most of that (N-19 in the findings doc): the app's QA run
  record says `emulator: true`, `observed-timing.mjs` refuses such a
  capture, and the verify suite asks the device and does not run the timing
  analyzer for one. **Not enforced:** a capture taken by hand from an
  emulator running a build older than `38d556f9` — an old APK installed to
  test an upgrade — says nothing about its device. Do not analyze one.

**The device.** AVD `punchcraft-emu`: Pixel Tablet profile (2560×1600),
Android 15 (API 35, Google APIs, x86_64), 4 GB. `helioscape-dev`
(`emulator-5554`) is another project's — leave it alone.

```bash
emulator -avd punchcraft-emu -no-window -no-snapshot -no-boot-anim -gpu host -port 5556   # → emulator-5556
adb -s emulator-5556 emu kill                                                            # stop it
```

(`emulator` is `%ANDROID_HOME%emulatoremulator.exe`; it is not on the PATH.)

**The build.** x86_64, the emulator's processor — four minutes here.

```bash
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=x86_64 && cd ..
adb -s emulator-5556 install -r android/app/build/outputs/apk/release/app-release.apk
```

*From a worktree:* `android/` is git-ignored and exists only in the main
checkout. Copy its sources into the worktree — everything except
`app/build`, `app/.cxx`, `.gradle` and `build` — and build there. Node
finds `node_modules` by walking up to the main checkout's, so the native
modules' build output lands there. The first such build also set
`externalNativeBuild { cmake { buildStagingDirectory 'F:/pcx-n18' } }` in
the copy's `android { }` block, against Windows's path limit (a worktree's
root is 43 characters longer); whether it was needed was not tested.

**Driving it.** QA mode must be on — Settings → QA mode, once per install.
The suite mutes the emulator and restores it.

```bash
node tools/analysis/verify-suite.mjs --only=quick-one-two --device=emulator-5556 --expect-release --out=tools/analysis/suites/<name>
```

On an emulator the suite reports the verdict and the correlator's stats,
marks timing "not judged", and prints the **work axis** in its place — per
round, how many ring tokens place the work clock and how far the
work-entered boundary record trails its zero. Those are the app's own two
clocks with no audio in them, and they mean on an emulator what they mean
on the tablet. The onset columns of its table are this PC's.

**Reading the database.** The image is a userdebug one, so:

```bash
adb -s emulator-5556 root
adb -s emulator-5556 shell sqlite3 /data/data/com.kyleruff.punchcraft/files/SQLite/punchcraft.db "SELECT id FROM schema_migrations"
```

**Testing an upgrade.** `artifacts/` in the main checkout holds September's
release APKs, built for every processor, x86_64 included. Install one, run
a workout to the end, then install the new build over it (`-r`: same id,
same debug keystore, so the data stays). The new build's migrations then
run on a database an old build wrote. An old build's QA link could still
switch QA mode on, and the switch survives the upgrade.

## Installing SDK components (after Story 1 lock)

If the spike locks Expo SDK 57 as expected, install what its Android template needs and accept licenses:

```bash
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager.bat" "platforms;android-36" "build-tools;36.0.0"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager.bat" --licenses
```

If Story 1 chooses the SDK 54 fallback (last SDK that can disable New Architecture), the target platform / build-tools set differs — record the actual versions here after the lock.

## Running the app (populated during Story 1)

Story 1 will fill in the exact scaffolding commands. Expected shape:

```bash
npm install
npx expo prebuild --clean            # CNG regenerates android/
npx expo run:android --device        # installs the dev-client build over USB
```

Metro can then be attached with `npx expo start --dev-client`. A release-like APK for the "launches without Metro" acceptance criterion is produced by `cd android && ./gradlew assembleRelease` (or the equivalent Windows batch) and copied to `artifacts/`.

Never commit the `android/` directory — it is regenerated by CNG on every clean prebuild (see `.gitignore`).

## Checks, and the commands that go with them

Added 2026-11-25. Everything here runs on the workstation with no tablet.

| Command | What it does |
|---|---|
| `npm run check` | The fast half of CI, about 20 s: `typecheck`, `typecheck:tools`, `lint`, `format:check`, both guards. |
| `npm run hooks:install` | Once per clone: points `core.hooksPath` at `.githooks`, so `npm run check` runs before every push. Applies to every worktree of the clone. `git push --no-verify` skips it. |
| `npm run format` | Rewrites `src/**/*.{ts,tsx}` and `tools/pc/**` to the Prettier config. `format:check` only reports. |
| `npm test` | The whole suite, about two minutes. App logging is silenced; `JEST_LOGS=1 npx jest path/to/test` brings it back. |
| `npm run typecheck:tools` | Type-checks the verifier and guard scripts (`tools/analysis`, `tools/guards`, `tools/dev`, and the `.mjs` under `tools/pc`), which the root `tsconfig.json` does not include. |
| `npm run pc:glove-check` | Serves the PC glove check on `http://127.0.0.1:8787/` (loopback only; `PORT=` moves it). Open it in Chrome or Edge. See below. |
| `npm run pc:app` | Builds the app for a browser and serves it on `http://127.0.0.1:8788/` (loopback only; `PORT=` moves it; `-- --no-build` serves the last build). See below. |
| `npm run pc:smoke` | Builds, then drives the PC app in a headless Chrome or Edge: boot, a workout on simulated punches, stop, save, reload, the saved database read back out of the browser, then History and the session's summary. Fails on any error on the page. About a minute after the build. Also runs in CI as an advisory job. |
| `npm run pc:suite` | The tablet's verify suite on the PC: drives every sample workout in a headless browser (round 1 and the rest after it; `-- --full` for whole workouts; `-- --only a,b`), has the tablet's correlator judge each, listens to what the page plays — calls, bells, intro, countdown, rest line — and checks that every ring lit. All 22 take about 22 minutes, six at a time; `--full` is 10 to 20 minutes a workout. Builds first, replacing `dist/pc-app/` — do not run `pc:app` or `pc:smoke` beside it. See `tools/pc/suite/README.md`. |
| `npm run pc:parity` | Compares the newest `pc:suite` run with the tablet reference (`tools/pc/suite/tablet-reference/`): what was said, in what order, at what scheduled time. `-- --build-reference <tablet suite folder>` rebuilds the reference after a tablet suite run. |
| `npm run tablet:reload` | Restarts Metro, cold-restarts the app on the tablet, waits for it to come up. `--no-metro` restarts only the app; `--dry-run` says what it would do. **Not yet proven on the device** — see the script's header. |

**The PC glove check** (added 2026-11-25) is the first piece of the PC
version: one browser page that connects a glove over **Web Bluetooth** and
runs the tablet's real start-up on it — `startPunchStream`, the FightCamp
adapter and decoder, the keepalive's beat — to find out whether this PC can
hold a glove and read its punches at all. It needs a person: a page may only
open the browser's device chooser from a click. What to do at the PC, how to
read the result, and exactly what it writes to a glove are in
[`tools/pc/glove-check/README.md`](../tools/pc/glove-check/README.md).
Bundled in memory by `esbuild` (a direct dev dependency since this was
added); nothing is written to disk. It is not the app in a browser — that is
`pc:app`, next.

**The PC app** (added 2026-11-26) is the app itself, built for a browser. It
boots, lists the workouts, runs one on **simulated punches** and saves the
session. What it does not do yet — the gloves, the moving backdrop — and
where its data lives are in
[`tools/pc/app/README.md`](../tools/pc/app/README.md). Three things about it
are worth knowing before changing anything near them:

- **A `*.web.ts` file replaces its sibling in the web build**, and only
  there: `src/storage/database.web.ts`, `src/ble/index.web.ts`,
  `src/audio/browserPlayback.web.ts`. Jest and the tablet never load them.
  They are the only files in `src` allowed the page's globals (`window`,
  `navigator`, `document`); eslint enforces that.
- **Its database is sql.js, not expo-sqlite.** The pinned expo-sqlite
  truncates any synchronous result of 256 bytes or more in a browser
  (`src/storage/sqlJsPort.ts` has the line). Same schema, same migrations,
  same repositories; the storage suites run against both engines. After
  pulling this in, run `npm install` once — `sql.js` is a new dependency.
  The database is kept in the browser's IndexedDB
  (`src/storage/idbByteStore.web.ts`).
- **`src/ble/gloveSupport.ts` is the one switch** for "this build cannot
  search for gloves". Do not sprinkle `Platform.OS === 'web'` around the
  Bluetooth code; ask `canFindGloves()`.

`pc:smoke` is the regression test for all of it, and the only thing that
exercises the real WebAssembly engine and the browser's own storage. It
drives the browser through its debugging port with node's built-in
WebSocket, so there is nothing to install — but it needs Chrome or Edge on
the machine. CI runs it as an advisory job (`pc smoke (advisory)`), outside
the `ci` gate until it has been seen green there. Run it yourself after
touching storage, the root layout, anything `*.web.ts`, the live screen's
start-up, or the history screens.

One thing to know about the Claude desktop app's built-in browser pane: **it
empties the origin-private file system of a page left idle about ten
minutes**, and leaves IndexedDB alone (findings doc, N-10). The PC database
was first kept in that file system and vanished there twice; it is in
IndexedDB now and survives. Do not build anything else for the PC version on
the private file system.

**The verifier's manifests are checked.** `tools/analysis/manifests/*.json`
is what the first-round verifier judges a drive against, generated from the
app's own code. `tools/analysis/__tests__/manifests-fresh.test.js` rebuilds
all 44 in the suite and fails when a committed one is stale — ten had been,
since September (N-11). When it fails, regenerate and **read the diff**:

```
node --import ./tools/analysis/wav-stub.mjs --import tsx tools/analysis/first-round-manifest.ts --all
node --import ./tools/analysis/wav-stub.mjs --import tsx tools/analysis/first-round-manifest.ts --all --vocab=techniques
```

A change you meant is a regeneration; one you did not is a timing
regression.

**Mining the captures on disk** (added 2026-11-26). Two read-only scripts
ask today's questions of logs that were captured for something else:

- `node tools/analysis/mine-ble-logs.mjs [dir] [--links|--json]` — every
  glove link in the captured app logs: when it came up, how long it was seen
  alive, how it ended, and the init and heartbeat write timings.
- `node tools/analysis/rejudge-captures.mjs [dir] [--changed|--all]` —
  re-runs today's first-round verifier over stored captures and says where
  a verdict moved. It is how to find out what the next suite drive will
  report without spending a tablet session on it.

Both default to `tools/analysis`, and both read the two log layouts on disk
(`-v time`, and the epoch-stamped one).

**Line endings and formatting are enforced.** Text is LF everywhere
(`.gitattributes`), and `src/**/*.{ts,tsx}` and `tools/pc/**` must match
`.prettierrc`. Two
groups are exempt from both and left exactly as committed: the generated
manifests, and the Puncheoke paths (`.prettierignore` lists them). The two
commits that did the one-time conversion are in `.git-blame-ignore-revs`;
`git config blame.ignoreRevsFile .git-blame-ignore-revs` makes `git blame`
skip them.

**CI** (`.github/workflows/ci.yml`) runs two jobs in parallel on every pull
request and every push to `main`: `static checks` (what `npm run check`
runs) and `tests`. A third job, `ci`, passes only if both did; require that
one if branch protection is ever switched on.

**The release APK is also built by CI** (`.github/workflows/release-apk.yml`)
on every push to `main` and on manual dispatch, and kept for seven days as
the artifact `punchcraft-release-<sha>`. It is signed with the same debug
keystore every `expo prebuild` generates, so it installs over a locally
built one with `adb install -r` and the tablet keeps its data. Building
locally still works exactly as described above. *It passes as of
2026-11-26 — once dispatched on a branch, once on `main` — in 12-14
minutes, with an artifact of about 860 MB. Its first run on `main` had
failed: the splash screen was configured with a colour and no image, so a
clean checkout had no `splashscreen_logo` drawable (fixed in
`app.config.ts`). Not yet done by anyone: installing that artifact over the
tablet's build.*

## Bluetooth HCI snoop (M01, only while the official app still connects)

On the tablet, enable Developer Options → **Enable Bluetooth HCI snoop log**. Reboot Bluetooth so the log restarts. Run one labeled scenario from §12.2, then pull the log:

```bash
adb bugreport captures/bugreport-YYYY-MM-DD-<scenario>.zip
```

The snoop log lives inside the bugreport (`FS/data/misc/bluetooth/logs/btsnoop_hci.log` on most devices; may also be at `/sdcard/btsnoop_hci.log` depending on the ROM). Open it in Wireshark and follow the workflow in `docs/protocol/README.md`.

## Windows PC ↔ tablet contract

- The PC and tablet must not connect to the same tracker at the same time (§5.1). While Metro-driven builds run and the tablet holds the connection, don't launch Bleak experiments against the same tracker from the PC.
- Raw captures and bugreports remain under `captures/` (git-ignored). Only curated replay fixtures under `src/protocol/**/fixtures/` are committed.

## Connect the tablet wirelessly (Android 11+)

Once the tablet has been paired at least once over USB, subsequent dev sessions can attach over Wi-Fi so the USB port stays free.

1. On the tablet, open **Settings → System → Developer options → Wireless debugging** and turn it on. Tap **Pair device with pairing code**. Note the six-digit pairing code and the `IP:PORT` shown on the pairing dialog (the pairing port is different from the connect port shown on the main Wireless debugging screen).
2. On the Windows workstation, in the same Wi-Fi network, run:

   ```bash
   adb pair <host>:<pairing-port>
   ```

   Paste the six-digit code when prompted. On success adb prints `Successfully paired`.
3. Then attach to the tablet using the connect port from the Wireless debugging main screen:

   ```bash
   adb connect <host>:<connect-port>
   ```

   Verify with `adb devices -l` — the tablet should appear as `<host>:<connect-port>  device`.

USB is still required for the first-time bugreport export of the HCI snoop log (see the HCI snoop section above) — `adb bugreport` over Wi-Fi can drop mid-transfer on large captures, and the initial pairing itself was easier to establish once over USB before falling back to wireless.
