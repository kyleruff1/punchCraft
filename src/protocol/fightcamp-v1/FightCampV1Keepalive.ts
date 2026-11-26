/**
 * What a central has to keep saying to a FightCamp v1 tracker to hold its
 * link, as constants — shared by the tablet's keepalive
 * (`src/protocol/trackerKeepalive.ts`, which owns the history and the
 * lifecycle) and the PC glove check (`tools/pc/glove-check/`), so the two
 * cannot drift apart.
 *
 * Pure constants. No RN / Expo / BLE / SQLite imports.
 */

/**
 * Heartbeat cadence and payload. An armed stream alone was not enough
 * (the glove hung up ~2min after connect+init while still), and
 * neither were periodic device-info READS (it outlived the bare
 * timeout but still hung up ~3-5min in) — the firmware's idle timer
 * evidently wants inbound WRITES, the traffic a session actually
 * produces. So the pulse is a re-assertion of mode-normal: the same
 * single 0x01 byte to COMMAND1 the init plan sends, idempotent, with
 * no timestamp semantics (unlike a clock re-sync, which would skew
 * the stream's epoch mid-workout). A known characteristic our init
 * already writes — rule 4 intact. 20s gives several beats per
 * observed timeout window.
 */
export const HEARTBEAT_INTERVAL_MS = 20_000
export const MODE_NORMAL_BASE64 = 'AQ=='

/**
 * Standard BLE Battery Service, which the trackers expose — Hykso's
 * session reads and subscribes it for its battery display
 * (`j1/g.java`: 0x180F / 0x2A19, one byte = percent).
 */
export const BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb'
export const BATTERY_LEVEL_UUID = '00002a19-0000-1000-8000-00805f9b34fb'
