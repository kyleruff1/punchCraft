/**
 * CaptureRepository — `ble_captures` lifecycle and batched `ble_frames` writes.
 *
 * This is the durable half of the persist-before-parse rule (CLAUDE.md §1,
 * spec §11.9 / §12.4). Frames are written verbatim: base64 AND hex, the
 * monotonic timestamp stamped in the native callback, and the connection
 * generation. Nothing here inspects the payload — a frame that the decoder
 * will later reject is stored exactly like one that decodes cleanly, which is
 * the whole point.
 *
 * Storage never imports from `src/ble/**`; the frame shape arrives as a plain
 * input record.
 */

import { logger, safe } from '@/diagnostics/logger'
import type { SqlBindValue, SqlPort } from '@/storage/SqlPort'

export interface OpenCaptureInput {
  label?: string | null
  appVersion?: string | null
  osVersion?: string | null
  notes?: string | null
}

/** A frame ready to persist. Mirrors RawBleFrame without importing from ble/. */
export interface FrameInsertInput {
  id: string
  captureId: string
  /** Resolved `tracker_devices.id`, or null when the device is not yet known. */
  deviceId: string | null
  /** The transport-reported BLE address, always recorded. */
  deviceAddress: string
  monotonicTimeMs: number
  wallTimeIso: string
  direction: string
  serviceUuid: string
  characteristicUuid: string
  valueBase64: string
  valueHex: string
  connectionGeneration: number
}

export interface CaptureRow {
  id: string
  label: string | null
  startedAt: string
  endedAt: string | null
}

interface RawCaptureRow {
  id: string
  label: string | null
  started_at: string
  ended_at: string | null
}

function newCaptureId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `cap_${Date.now().toString(36)}_${rand}`
}

export class CaptureRepository {
  constructor(private readonly db: SqlPort) {}

  /** Start a capture and return its id. Frames reference this id. */
  open(input: OpenCaptureInput = {}): string {
    const id = newCaptureId()
    const stmt = this.db.prepareSync(
      `INSERT INTO ble_captures (id, label, started_at, app_version, os_version, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    try {
      stmt.executeSync([
        id,
        input.label ?? null,
        new Date().toISOString(),
        input.appVersion ?? null,
        input.osVersion ?? null,
        input.notes ?? null,
      ])
    } finally {
      stmt.finalizeSync()
    }
    logger.info('storage.capture.open', 'capture opened', { captureId: safe(id) })
    return id
  }

  /** Mark a capture ended. Idempotent — re-closing keeps the first end time. */
  close(captureId: string): void {
    const stmt = this.db.prepareSync(
      'UPDATE ble_captures SET ended_at = COALESCE(ended_at, ?) WHERE id = ?',
    )
    try {
      stmt.executeSync([new Date().toISOString(), captureId])
    } finally {
      stmt.finalizeSync()
    }
    logger.info('storage.capture.close', 'capture closed', { captureId: safe(captureId) })
  }

  /**
   * Insert a batch of frames inside a single transaction.
   *
   * Returns the number written. A failure rolls the whole batch back and
   * rethrows — the caller decides whether to retry or surface an overrun,
   * because silently dropping frames would violate the persist-before-parse
   * guarantee just as surely as never writing them.
   */
  insertFrames(frames: readonly FrameInsertInput[]): number {
    if (frames.length === 0) return 0

    this.db.execSync('BEGIN')
    const stmt = this.db.prepareSync(
      `INSERT OR IGNORE INTO ble_frames
         (id, capture_id, device_id, device_address, monotonic_time_ms, wall_time_iso,
          direction, service_uuid, characteristic_uuid, value_base64, value_hex,
          connection_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    try {
      for (const f of frames) {
        stmt.executeSync([
          f.id,
          f.captureId,
          f.deviceId,
          f.deviceAddress,
          f.monotonicTimeMs,
          f.wallTimeIso,
          f.direction,
          f.serviceUuid,
          f.characteristicUuid,
          f.valueBase64,
          f.valueHex,
          f.connectionGeneration,
        ])
      }
      stmt.finalizeSync()
      this.db.execSync('COMMIT')
      return frames.length
    } catch (err) {
      try {
        stmt.finalizeSync()
      } catch {
        /* already finalized */
      }
      this.db.execSync('ROLLBACK')
      logger.error('storage.frames.insert.failed', 'frame batch insert failed', {
        count: safe(frames.length),
        error: safe(String(err)),
      })
      throw err
    }
  }

  /** Count frames in a capture. Used by the capture UI and by exports. */
  countFrames(captureId: string): number {
    const stmt = this.db.prepareSync('SELECT COUNT(*) AS n FROM ble_frames WHERE capture_id = ?')
    try {
      const rows = stmt.executeSync<{ n: number }>([captureId]).getAllSync()
      return rows[0]?.n ?? 0
    } finally {
      stmt.finalizeSync()
    }
  }

  /** Every capture carrying `label`, with its frame count. Oldest first. */
  listByLabel(label: string): Array<{ id: string; startedAtIso: string; frames: number }> {
    const stmt = this.db.prepareSync(
      `SELECT c.id AS id, c.started_at AS started_at,
              (SELECT COUNT(*) FROM ble_frames f WHERE f.capture_id = c.id) AS frames
         FROM ble_captures c
        WHERE c.label = ?
        ORDER BY c.started_at ASC`,
    )
    try {
      return stmt
        .executeSync<{ id: string; started_at: string; frames: number }>([label])
        .getAllSync()
        .map((r) => ({ id: r.id, startedAtIso: r.started_at, frames: r.frames }))
    } finally {
      stmt.finalizeSync()
    }
  }

  /**
   * Mark every still-open capture carrying `label` ended, at the time of its
   * last frame (or its start, if it never held one). Returns how many.
   *
   * For the ambient capture, which is normally ended by the app being
   * killed rather than by anything calling `close()`.
   */
  closeAbandoned(label: string): number {
    const open = this.select<{ n: number }>(
      'SELECT COUNT(*) AS n FROM ble_captures WHERE label = ? AND ended_at IS NULL',
      [label],
    )[0]?.n
    if (!open) return 0
    this.run(
      `UPDATE ble_captures
          SET ended_at = COALESCE(
                (SELECT MAX(f.wall_time_iso) FROM ble_frames f WHERE f.capture_id = ble_captures.id),
                started_at)
        WHERE label = ? AND ended_at IS NULL`,
      [label],
    )
    return open
  }

  /** How many frames a capture holds on each characteristic. */
  frameCountsByCharacteristic(captureId: string): Record<string, number> {
    const rows = this.select<{ characteristic_uuid: string; n: number }>(
      `SELECT characteristic_uuid, COUNT(*) AS n
         FROM ble_frames WHERE capture_id = ?
        GROUP BY characteristic_uuid`,
      [captureId],
    )
    return Object.fromEntries(rows.map((r) => [r.characteristic_uuid, r.n]))
  }

  /**
   * Delete captures and, by cascade, their frames. Returns how many captures
   * went.
   *
   * `punch_events.capture_id` cascades too — so only ever pass captures that
   * no punch event was recorded under. The ambient capture is one: decoded
   * events are recorded under a labelled capture or not at all.
   */
  deleteCaptures(ids: readonly string[]): number {
    if (ids.length === 0) return 0
    this.db.execSync('BEGIN')
    try {
      for (const id of ids) this.run('DELETE FROM ble_captures WHERE id = ?', [id])
      this.db.execSync('COMMIT')
    } catch (err) {
      this.db.execSync('ROLLBACK')
      throw err
    }
    logger.info('storage.capture.pruned', 'captures deleted', { count: safe(ids.length) })
    return ids.length
  }

  private select<TRow>(sql: string, params: SqlBindValue[]): TRow[] {
    const stmt = this.db.prepareSync(sql)
    try {
      return stmt.executeSync<TRow>(params).getAllSync()
    } finally {
      stmt.finalizeSync()
    }
  }

  private run(sql: string, params: SqlBindValue[]): void {
    const stmt = this.db.prepareSync(sql)
    try {
      stmt.executeSync(params)
    } finally {
      stmt.finalizeSync()
    }
  }

  /** Most recent captures first. */
  listRecent(limit = 20): CaptureRow[] {
    const stmt = this.db.prepareSync(
      'SELECT id, label, started_at, ended_at FROM ble_captures ORDER BY started_at DESC LIMIT ?',
    )
    try {
      const rows = stmt.executeSync<RawCaptureRow>([limit]).getAllSync()
      return rows.map((r) => ({
        id: r.id,
        label: r.label,
        startedAt: r.started_at,
        endedAt: r.ended_at,
      }))
    } finally {
      stmt.finalizeSync()
    }
  }
}
