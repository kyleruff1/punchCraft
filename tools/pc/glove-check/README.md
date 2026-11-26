# PC glove check

One page that connects a FightCamp v1 glove to this PC through the browser's
Web Bluetooth and runs the tablet app's real start-up on it. It exists to
answer one question before any more of the PC version is built: **can this
PC, from a browser, hold a glove and read its punches?**

```
npm run pc:glove-check
```

Open the printed `http://127.0.0.1:8787/` address in **Chrome or Edge**
(Firefox has no Web Bluetooth). `PORT=9000 npm run pc:glove-check` moves it.

## What to do

1. Wake **one** glove — tap it. Blue is left, red is right.
2. Click that glove's Connect button and pick **FightCam** in the browser's
   list.
3. Throw a few punches. Leave it connected for at least a minute.
4. Do the other glove.
5. **Copy report** and paste it wherever it is wanted. **Download raw
   frames** saves every frame received, as JSONL in the `RawBleFrame` shape —
   put it under `captures/` (git-ignored) if it is worth keeping.

## Reading the result

- **Holding** — the link outlived 45 s. The glove's security request was
  answered, so this PC can hold it. This is the result the PC version needs.
- **Dropped once / dropped N times inside 30-45 s** — the not-bonded
  signature (H13 in `docs/protocol/hypotheses.md`). The page reconnects once
  to see it twice, then stops. A page cannot ask for pairing; try pairing
  "FightCam" in Windows Settings → Bluetooth & devices → Add device, then
  connect again. **Whether that cures it for a browser is not known yet** —
  the September spike bonded through a native library, which a page cannot
  use. That is one of the things this page is here to find out.
- **Glove: read from the glove** — the glove's System ID carried its address,
  so the PC version can tell left from right by itself. **Going by the
  button** means it could not, and hand stays a choice on the PC.
- **Status byte** — the glove's own status (`ca281073`), read before anything
  is written and again after the start-up. The official app gates "ready" on
  bit 4 of it: set, and it requires an OS bond; clear, and it writes command 16
  (H14). The page only reads and reports — **it never sends command 16**. Set
  against whether the link held, this is the first evidence of what the bit
  means. Anything the glove pushes on that channel, and any string on its
  error channel (`ca281078`), shows on the timeline.
- **Latency** — arrival time minus the tracker's own timestamp, for punches
  that arrived live. Punches the glove had buffered are marked and left out.

## If the browser's list is empty

Not verified on a PC; these are the two known reasons a glove is invisible:

- It is asleep. Tap it (H02: the blue one sleeps after about ten still
  seconds).
- It is talking only to the tablet. A bonded glove can advertise *directed*
  at its partner (`src/ble/autoConnectTrackers.ts`). Switch the tablet's
  Bluetooth off and try again.

## What it does to a glove

Everything it writes is something the tablet app already writes
(CLAUDE.md rule 4), from the same code:

1. connects;
2. **reads** the status byte;
3. **reads** System ID — if that shows the glove is the *other* hand, it hangs
   up there, before anything is written;
4. runs `FightCampV1Adapter.buildInitializationPlan` through
   `startPunchStream`: clock sync, three subscriptions, a device-info read,
   mode-normal, the hand byte, command 17;
5. **reads** the status byte again, then battery and the Device Information
   strings;
6. every 20 s, the keepalive's mode-normal byte and a battery read.

Gloves are brought up one at a time: in the September spike a connect that
landed inside the other glove's security procedure failed.

## How it is built

`gloveCheck.ts` is all of the behaviour and has no DOM in it; `main.ts` draws
it; `report.ts` writes the report. `serve.mjs` bundles with esbuild in memory
and serves on loopback only. `__tests__/bundle.test.js` fails if anything the
page imports stops being runnable in a browser.
