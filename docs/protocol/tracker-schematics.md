# FightCamp v1 (Hykso) Tracker Schematics

**The canonical emissions reference for punchCraft's BLE trackers.**
Compiled 2026-09-05 from: `src/protocol/fightcamp-v1/**`, `src/ble/**`,
`docs/protocol/hypotheses.md` (H01–H12), the decompiled vendor app
(`artifacts/reversing/hykso-src/`, jadx of `com.hykso.hyksofit`), the
committed live-capture fixture (`spike-mt4wm1d8-fx6x.json`), and a fresh
pull of the on-device `punchcraft.db` (63 punch events, 73 matched cue
rows, 41 sessions).

> **Status of this file — added 2026-11-25.** Compiled 2026-09-05 and kept,
> until now, only in the retired `C:\Users\kyler\punchlab` folder; it was
> never committed. It is brought in **unchanged below this note** because it
> is the fullest tracker reference there is, and three things in it were
> recorded nowhere in the repo: the vendor's bond gate (§9), what commands
> 16 and 17 are (§6), and that `ca281078` carries error strings rather than
> acknowledgements (§2). `hypotheses.md` H13 and H14 now cite them, and the
> claims were re-read against the decompiled source on 2026-11-25.
>
> **What has changed since it was written:**
>
> - §3, §4b, §11.1 — `accelerationRaw` is no longer discarded. It has been
>   on `TrackerPunchEvent` since `183aa786` (2026-09-05).
> - §2, §11.6 — the app still never reads Device Information, but the PC
>   glove check (`tools/pc/glove-check/`) reads five of its strings and the
>   System ID. The vendor reads six strings and waits for all of them before
>   starting a session; it identifies a tracker by Serial Number (`0x2A25`),
>   which a browser refuses to read, and never reads System ID.
> - §9 — still true that the app never reads the status byte, never sends
>   command 16 and has no bond receiver. It does now recognise the 37 s
>   signature and say "Not paired?" (`src/ble/bondDiagnosis.ts`, H13), and
>   the PC glove check reads the status byte.
> - §4c — both persistence traps were re-confirmed on 2026-11-25: the frame
>   sink is installed only by `startCapture()`, which only the three
>   Velocity Lab routes call, so a workout persists no raw frames; and a
>   workout stores only the punches its cue results name.
> - §14 — the device database pulled on 2026-09-05 is not on this disk any
>   more. The 21 GB of monitor captures were re-mined on 2026-11-25
>   (`docs/handoff/08-review-and-roadmap.md` §3e): still no tracker payloads.
> - **Line numbers** are as of 2026-09-05 and have drifted, most of them in
>   the one-time Prettier reformat. Trust the file and symbol names.
>
> Everything else stands as compiled and has not been re-verified line by
> line.

---

## 1. Identity — left vs right

| Tracker | Color | Hand | BLE address | Address type |
|---|---|---|---|---|
| A | **Blue** | **LEFT** | `D7:34:B4:27:D5:84` | random-static (stable forever) |
| B | **Red** | **RIGHT** | `EA:69:2D:9C:FD:53` | random-static (stable forever) |

- Hard-coded in `src/ble/knownTrackers.ts:32-35`.
- Advertise as local name **`FightCam`** (8 chars — the trailing 'p' is
  clipped by the 31-byte advertisement limit) + one 128-bit service UUID.
  No manufacturer data. (H01)
- **Hand is assigned by us, not reported by the device.** The wire
  carries no hand bit; the slot the address is bound to stamps `hand` on
  every event (re-stamped in `PunchStream.ts:75` and
  `TrackerPunchEventSource.ts:329-330` so the slot always wins).
  The vendor writes the hand TO the tracker via `ca281072`
  (`1` = right, `2` = left) — role of that write on-device is unknown.
- Must **scan before connecting**: Android resolves a bare address
  string as PUBLIC type; without a scan result (or bond) the connect
  aims at the wrong address type and times out
  (`autoConnectTrackers.ts:36-49`).

## 2. GATT map — the full canvas

Six services, 25 characteristics per tracker (H05). Custom service:
`ca280069-5470-4e34-94dd-caf160200b29`; all custom characteristics share
the `-5470-4e34-94dd-caf160200b29` suffix.

| UUID | Props | We do | Vendor does | True role (vendor source) |
|---|---|---|---|---|
| `ca281069` | indicate | subscribe — **the punch stream** | same | Punch record stream (1–2 records/frame) |
| `ca281070` | read | read at init + re-read every reconnect (keepalive), hex stored/logged, never decoded | read | **Punch counter, 16-bit LE** (vendor label — cumulativeness unverified; vendor decode lacks unsigned masking) — candidate cross-check for dropped notifications |
| `ca281071` | read/write | write mode + 20 s keepalive | same | Command channel (table §6) |
| `ca281072` | read/write | write hand byte | same | Hand assignment: 1=right, 2=left |
| `ca281073` | read/notify | subscribe, frames discarded | subscribe **and read** | **Status byte; bit 4 (0x10) = bond gate** (§9) |
| `ca281074/5/6` | read/write | untouched | untouched | Unknown config — prime suspects: threshold readback, sleep timer, sensitivity |
| `ca281077` | notify | untouched | untouched | Silent (H07-REVISED — the original wrong guess for the punch stream) |
| `ca281078` | indicate | subscribe, frames discarded | subscribe | **Error/assertion channel — UTF-8 string payload** (never observed live) |
| `ca281079` | write | 5-byte clock-sync at init/start | same, always first | Clock sync (§7) — **width is load-bearing** |

Standard services: Battery `0x180F` (`0x2A19` read+notify — we poll, vendor
subscribes), Device Information `0x180A` (six strings — **we never read
it**; firmware version is assumed `4`), Nordic **Legacy** DFU
(`0x1531/0x1532/0x1534` — pre-2017 bootloader, accepts unsigned images;
untested; backlog #162), Generic Access/Attribute (untouched).

## 3. The punch record — 9 bytes (firmware ≥ 4, the live path)

Decoder: `src/protocol/fightcamp-v1/FightCampV1Decoder.ts:218-273`,
transcribed from vendor `session/d.java:41-56`.

| Offset | Width | Field | Endian | Meaning |
|---|---|---|---|---|
| 0 | u8 | `punchTypeRaw` | — | type code, observed **0–5** (§5) |
| 1–2 | u16 | `accelerationRaw` | LE | peak accel; vendor `/100` ≈ g-force. **Parsed then DISCARDED** — never reaches `TrackerPunchEvent` |
| 3–6 | u32 | `epochSeconds` | LE unsigned | absolute Unix seconds (tracker clock, set by our clock-sync) |
| 7 | u8 | `subSecond256` | — | `ms = byte·1000/256` → **3.906 ms timestamp quantum** |
| 8 | u8 | `velocityByteRaw` | — | our `velocityRaw`, verbatim undivided byte |

Vendor velocity curve (we store it as `velocityCalibrated`; never used live):

```
v = velocityByteRaw / 2
v ≤ 4 → velocity = v · 0.5
v ≤ 8 → velocity = (v − 4) · 3 + 2
else  → velocity = (v − 8) · 6 + 14
if punchTypeRaw ∈ {1, 2} → velocity ×= 1.7     // NOT comparable across types
```

- Frames are 9 or 18 bytes = 1 or 2 records. Any other length →
  `malformed`, never throws.
- **MTU is never negotiated** (default ATT 23 → 20-byte payload), so a
  3-record frame cannot fit — likely why the vendor caps at 2.
- **Vendor bug**: the official Hykso app slices the second record as 8
  bytes then requires length 9 — it **silently drops the second punch of
  every 18-byte frame** (`X/a0.java:79-88`). We decode both. Official-app
  punch counts under-report fast doubles.
- Legacy 13-byte layout exists for firmware < 4
  (`FightCampV1Decoder.ts:275-318`); all probed trackers are ≥ 4.
  (Divergence: vendor applies ×1.7 on the legacy path too; our legacy
  decoder doesn't. Latent.)

## 4. Event schemas — every readout, layer by layer

### 4a. `RawBleFrame` (`src/ble/bleTypes.ts:80-94`) — pre-decode

`id`, `captureId`, `deviceId`, `handAtCapture`, `monotonicTimeMs`
(stamped from `performance.now()` **before** parsing), `wallTimeIso`,
`direction` (`notification|indication|read|write`), `serviceUuid`,
`characteristicUuid`, `valueBase64`, `valueHex`, `rssi?`,
`connectionGeneration`. Persist-before-parse is structural — the frame
sink sees every frame before the decoder does
(`BleManagerBlePlxImpl.ts:591-596`).

### 4b. `TrackerPunchEvent` (`src/domain/punch/PunchEvent.ts:26-44`) — decoded

| Field | Type | Reality on FightCamp v1 |
|---|---|---|
| `id` | string | `${frameId}-r${recordIndex}` |
| `hand` | `'left'\|'right'\|'unknown'` | from the slot, never the payload |
| `trackerTimestampMs?` | number | device epoch ms, 3.906 ms quantized |
| `receivedMonotonicTimeMs` | number | arrival `performance.now()` |
| `receivedWallTimeIso` | string | arrival wall clock |
| `sequence?` | number | **always undefined** — protocol has no sequence number |
| `punchTypeRaw?` | number | byte 0 verbatim, 0–5 |
| `punchType?` | enum | **always `'unknown'`** — `mapType()` returns it unconditionally (H12 policy) |
| `velocityRaw?` | number | byte 8 verbatim (observed ~2–20) |
| `velocityCalibrated?` | number | vendor curve incl. ×1.7 — cross-type incomparable |
| `velocityUnit` | literal | always `'tracker-unit'` (terminology doctrine §4.3) |
| `recovered` | boolean | true when arrival − deviceTs > 3000 ms (offline-buffer drain) |
| `decoderId/Version` | strings | `fightcamp-v1` / `1.0.0` |
| `qualityFlags` | array | decoder only ever sets `unknownType` (byte outside 0–5) |

**Not on the event, but on the wire:** `accelerationRaw` (bytes 1–2) —
the single richest unused per-punch signal. Fixture range:
`0x0084`–`0x0270` = 1.32–6.24 "g".

### 4c. DB rows

`punch_events` mirrors `TrackerPunchEvent` + `session_id`, `round_id`,
`capture_id`, `device_address`, `rejection_reason`, `calibration_profile_id`.
Dedup = UNIQUE(`device_address`,`tracker_timestamp_ms`,`punch_type_raw`,`velocity_raw`)
with INSERT OR IGNORE (no sequence number exists).
`cue_results` adds the ground-truth labels: `block_id`, `repeat_index`,
`token_index`, `expected_hand`, `outcome`
(`matched|hand-mismatch|type-mismatch|missed|late|during-pause`),
`offset_ms`, and passthrough velocity fields.

**Persistence traps (both confirmed at HEAD):**
- Workouts persist **only cue-matched punches** (`_useWorkoutRunner.ts:1459`
  writes `matchedEventsRef` only). Rest-gap punches, extras, unmatched,
  and abandoned-session punches are never stored.
- `ble_frames` only records while a capture session is open, and only the
  three Velocity Lab routes open one (`useCaptureSession`:
  `live-decode`, `protocol-probe`, `ble-spike`). Workouts never do.

## 5. The type byte — what we know (H12 + fresh DB census)

Vendor never names the codes (not even in decompiled source). Two
findings, one athlete each:

**H12 capture (~100 events, 10 labeled sets, 2026-08-23):**
- Red (right): hooks land as byte `2` (88%); no velocity threshold.
- Blue (left): hooks land as byte `1` (80%); byte is a pure **velocity
  gate**: `velocityByteRaw ≥ 10` → `{3,4}` (13/13), `≤ 9` → `{1,2}`
  (32/34). Device-local behavior — the codes do NOT transfer between
  units. Derived tables live in `src/domain/punch/typeConcordance.ts`
  (`H12_DEVICE_PROFILES`, samples 42+47, `provisional: true`).

**Fresh device DB (63 events, punchcraft sessions, 2026-08/09):**

| type_raw | left (blue) | right (red) | velocity range |
|---|---|---|---|
| 1 | 30 | 4 | 3–9 |
| 2 | 1 | 16 | 4–8 |
| 3 | 3 | 1 | 2–7 |
| 4 | 1 | 1 | 7–9 |
| 5 | 3 | 3 | 4–10 |

Consistent with H12's device-local split (type 1 dominant on blue,
type 2 dominant on red at these low velocities). Codes 0–5 all exist;
5 appears on both hands. **Decoding this byte per-device with labeled
ground truth is the #1 goal of the capture campaign.**

Velocity histogram (73 matched cue rows): 2–10 observed, mode 7,
mean 6.26 — integers only. Effects-lab constants pin the working range
as soft 6 / medium 9 / hard 14; impulse scaler warm-starts at 5..14 with
observed athlete range "~4..20".

## 6. Command tables

`ca281071` (COMMAND1), names from the vendor's own debug map + log strings:

| Byte | Meaning |
|---|---|
| 0 | Idle Mode (we send on stop) |
| 1 | Normal Mode — enables the punch stream; also the 20 s keepalive pulse |
| 2 | Gym Mode (unexplored) |
| 3 | Fetch Mode (unexplored — likely explicit offline-sync drain) |
| 4 | Test Mode (unexplored) |
| 5 | Normal Kick (unexplored — distinct sensing mode) |
| 15 | Shutdown (we send on sleep) |
| 16 | Bond/pairing request (sent when status bit 0x10 is clear — we never send) |
| 17 | **"Set new Threshold to 30"** (vendor callback log) — sets the punch-detection threshold, i.e. the transmit floor. The write carries NO argument (bare byte `17`); the value 30 is firmware-fixed. We send it blind as the last init write |
| 18 | unnamed, never sent by anyone |

`ca281072` (COMMAND2): `0` = unknown, `1` = Right, `2` = Left.

## 7. Clock sync — `ca281079`, exactly 5 bytes

`[secs LE ×4][subSecond256]` of "now". Sent first at every init and
session start. The adapter's init-plan comment records that without it
the tracker stayed connected but **never emitted punch frames**
(observed 2026-08-22) — note an internal tension: H07-REVISED's
2026-08-23 probe recorded frames flowing with NO `ca281079` write; the
code comment (`FightCampV1Commands.ts:70-72`) explicitly supersedes that
reading, but `hypotheses.md` was never updated. Separately, a
wrong-length write appears to **scramble the device clock**: H07-REVISED
+ H10 record two 1-byte writes of `01` during the probe, after which
frames carry a `c2 a8` epoch-high pair that decodes (H11 layout,
`0xa8c20011`) to **2059-09-20**, while pre-write frames decode to
2026-08-23. That interpretation is our derivation from the doc's raw
bytes (verified numerically), not a conclusion hypotheses.md itself
states. Either way: treat the 5-byte width as load-bearing.

## 8. Rates, latency, duty cycle

- **Per-punch delivery, acknowledged indications.** No streaming, no
  fixed cadence. 1–2 records per frame.
- Measured adjacent-punch spacing (fixture): ~390–730 ms live throwing;
  fastest adjacent frames 286 ms; doubles pack into one frame.
- **Transmit floor is real**: below the acceleration threshold (cmd 17
  = 30) the tracker sends **nothing** — "threw softly" and "didn't
  throw" are indistinguishable by construction (10 deliberately soft
  uppercuts → 1 event).
- **Offline buffering is real**: punches thrown while disconnected drain
  on the next mode-normal write with absolute timestamps intact
  (observed 22–66 s late → `recovered: true`; backfill threshold 3 s).
- Timestamp quantum 3.906 ms; per-event latency measurable as
  `receivedMonotonic − trackerTimestamp` (after clock-sync).
- **Connection priority: Balanced, deliberately** (~30–50 ms interval).
  High on both gloves overloads the MediaTek scheduler and sheds the
  second link ("the second glove always dies", 2026-08-29).
- **Keepalive**: every 20 s per glove — write `0x01` to `ca281071` +
  battery read. Firmware idle timer wants inbound WRITES: silent central
  → hangup ~60–90 s; armed stream only → ~2 min; reads only → 3–5 min.
- **Power-save wrinkle (H02)**: blue goes notification-silent after
  ~10 s of stillness (link stays up; tap wakes it); red doesn't. Cause
  unknown (firmware rev? config char?).
- Stack fragility (H04): overlapping connects wedge the tablet's BT
  stack (recovery = BT toggle + cradle both trackers). Mitigations:
  serial connects, subscription dedup, never re-connect a ready device.

## 9. Bonding

Vendor state machine (decompiled, `C0452b.java:208-269`): read
`ca281073`; **byte 0 bit 4 = bonding enabled**. If clear → write cmd 16.
If set → require OS bond (`BOND_BONDED`); peripheral initiates via SMP
Security Request; vendor listens for the OS pairing prompt.
**punchCraft implements none of this** — never reads the status byte,
never sends 16, no bond receiver. Field observation: unbonded gloves die
at ~37 s (Security Request + 30 s SMP timeout); pairing once as
"FightCam" makes both hold. Unresolved whether the Security Request
explains the remaining clean-disconnect drops.

## 10. Battery

`0x2A19`, 1 byte, 0–100. We poll on the 20 s keepalive; the tracker
also supports notify (vendor subscribes; we don't).

## 11. What we receive and throw away (the unexplored canvas)

1. **`accelerationRaw`** — parsed per punch, dropped before the event.
   The raw frame bytes preserve it, though: any `ble_frames` capture
   retains acceleration for offline decoding, no decoder change needed.
2. **`ca281070` punch counter** — 16-bit LE (cumulativeness
   unverified); candidate detection-loss cross-check (read before/after
   a block, compare the delta against decoded event count).
3. **`ca281073` status byte** — subscribed, discarded; 7 unmapped bits
   beyond the bond gate.
4. **`ca281078` assertion channel** — subscribed, discarded; UTF-8
   error strings.
5. **`ca281074/5/6` config chars** — untouched by us AND vendor;
   candidates for threshold readback / sleep timer / sensitivity.
6. **Device Information service** — never read; firmware version
   assumed (record width guessed as 9).
7. **Battery notify, RSSI, DFU version** — unused.
8. **Modes 2/3/4/5** — unexplored sensing modes (Fetch = likely
   explicit buffer drain; Normal Kick = different classifier?).

## 12. Raw IMU — the definitive answer

**No raw IMU/accel/gyro/quaternion stream exists in this firmware.**
Zero hits across the entire decompiled vendor app; the only per-punch
physical quantity is the single peak-acceleration u16 we discard. The
one path that could ever change this: the exposed **Nordic Legacy DFU**
bootloader accepts unsigned images → custom firmware is
transport-feasible (untested; backlog #162). Until then, the controller
canvas is **event-primitive**: hand × type-code × velocity × accel-peak
× 3.9 ms timestamps × rhythm — not continuous position. "Theremin"
interactions must be built from event derivatives (rate, alternation,
charge envelopes), not proximity.

## 13. Known unknowns (ranked for the capture campaign)

1. Type-byte semantics per device (labeled Rosetta run decides).
2. `accelerationRaw` scale + its relation to velocityByte (plumb it
   through first — one-line decoder change + event field).
3. Threshold tunability: cmd 17 carries no argument (the 30 is
   firmware-fixed), so lowering the transmit floor needs a different
   lever — the unexplored config chars `ca281074/5/6`, or other command
   bytes.
4. Config chars `ca281074/5/6` read-back (safe reads first).
5. Punch-count characteristic as per-block detection-loss audit.
6. Status byte's other 7 bits; assertion channel contents.
7. Negotiated connection interval (latency floor per glove).
8. Fetch/Gym/Test/Kick modes.
9. MTU negotiation → 3-record frames?
10. Firmware revision strings of both physical units (explains H02
    blue/red asymmetry?).

## 14. Where data lands today (capture-campaign baseline)

- Committed raw corpus: **one 21-record fixture** (~2 KB). H12's ~100
  events survive only as summary tables in `hypotheses.md`.
- On-device DB (pulled 2026-09-05): 63 punch_events, 73 velocity-bearing
  cue rows, 14,901 glove-off "missed" rows, 41 sessions / 363 min.
- 21 GB of monitor captures exist but are all audio/video/scheduling —
  **zero tracker payloads** (the app logs no per-punch line; only 9 of
  81 runs even had trackers connected).
- HCI snoop is hardware-blocked on this tablet (H08) — app-layer
  capture (`ble_frames`) is the only raw channel, and it works.
