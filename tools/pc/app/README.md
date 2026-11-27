# The PC version of the app

The same app the tablet runs, built for a browser and served on this machine.
It boots, lists the workouts, runs one — clock, rings, avatar, the coach's
calls — on **simulated punches**, and saves the session.

```
npm run pc:app
```

Builds (a few minutes the first time, seconds after), then serves on
`http://127.0.0.1:8788/`. Open that in **Chrome or Edge**.
`npm run pc:app -- --no-build` serves the last build as it is;
`PORT=9000 npm run pc:app` moves it. The build lands in `dist/pc-app/`
(git-ignored). The server binds the loopback address only — the app is not
reachable from the network.

## What it does not do yet

- **The gloves.** Nothing in the PC app connects one. A browser cannot scan
  for devices, so everything that would (launch auto-connect, the Connect and
  Fix buttons, the live screen's reconnect) is switched off here
  (`src/ble/gloveSupport.ts`). `npm run pc:glove-check` is the separate page
  that tries a glove from a browser; a pairing screen inside the app comes
  after that page has been run against a real one.
- **The moving backdrop.** It is drawn with Skia, which in a browser needs
  CanvasKit — a few megabytes the build does not carry. A built workout gets
  the still glow instead. Library workouts never had the moving backdrop.
- **Velocity Lab** opens, and has nothing to show without a glove.
- **The coach has not been heard here.** Calls are dispatched on time
  (7-9 ms late in the browser); nobody has yet listened to them on a PC.

## Where the data lives

In the browser's IndexedDB for `127.0.0.1:8788` — one SQLite database, the
same schema and migrations as the tablet's, kept as a single blob. It is not
the tablet's data and does not sync with it. A different port, or a different
browser, is a different (empty) database. Clearing the site's data in the
browser deletes it.

The engine is sql.js, not the tablet's expo-sqlite; `src/storage/sqlJsPort.ts`
says why. Three things follow from how it saves — the whole database, about
a second after each write, and at once when the tab is hidden:

- **Give it a second before you close or reload the tab.** A save started as
  the page goes away does not finish, so writes from the last second are
  lost. What was saved before is never damaged.
- **One tab at a time.** A second tab would save its own copy over the
  first's, so it does not start; it says the app is already open.
- **If the browser drops the database, the app says so.** A load that finds
  none where one was saved logs `storage.web.savedFileMissing` as an error
  and starts empty.

**Why IndexedDB.** The database was first kept as a file in the browser's
private file system. Chrome keeps that faithfully; the Claude desktop app's
built-in browser pane empties it for a page left idle about ten minutes, and
two saved sessions vanished that way. IndexedDB survives there: with the
database in IndexedDB and a canary file in the old place, thirteen idle
minutes took the canary and left the database, and a reload restored it
(2026-11-27). Nothing saved under the old scheme is carried over.

## The smoke test

```
npm run pc:smoke
```

Builds, starts Chrome or Edge headless on a throwaway profile, and drives the
app: boot, switch on QA mode in Settings, reload, start a workout through the
QA link with simulated punches, wait for round 1, stop, save, reload, then
read the saved database out of the browser and open it outside the app, and
last, open a second tab and see that it does not start. It fails on any
error on the page — a thrown error, an unhandled rejection, an error-level
log, a failed request. About a minute after the build.

`npm run pc:smoke -- --no-build` skips the build. `PC_SMOKE_BROWSER` names a
browser if yours is somewhere unusual. It drives the browser through its
debugging port with node's built-in WebSocket, so there is nothing to
install. It is not part of CI: it needs a browser on the machine.

What it cannot tell you is whether the coach is audible. It runs muted.
