/**
 * SettingsRepository — durable user preferences (M34-05, spec §17.1).
 *
 * A key/value store over `app_settings`, one JSON blob per key.
 *
 * ## Reads never throw
 *
 * `read` returns the fallback for a missing row *and* for an unreadable one.
 * A settings table is not worth crashing a workout over: if the stored JSON
 * is corrupt the honest recovery is to fall back to the defaults and say so
 * in the log, not to refuse to start. That is the opposite of the
 * `generated_workouts` policy, where a corrupt payload must surface — because
 * there the row *is* the record of what happened, and quietly substituting a
 * default would fabricate history.
 *
 * Talks to SQLite through `SqlPort` so the suite runs without the native
 * binding (spec §21).
 */

import { logger, safe } from '@/diagnostics/logger'
import type { SettingsKey } from '@/storage/migrations/006_app_settings'
import type { SqlBindValue, SqlPort } from '@/storage/SqlPort'

interface RawSetting {
  value_json: string
}

export class SettingsRepository {
  constructor(private readonly db: SqlPort) {}

  /**
   * Read one setting and CHECK it. This is the read to use.
   *
   * A row is JSON, and JSON has no types: it may have been written by an
   * older build, by a build with a bug, or edited by hand. `normalize` is
   * handed whatever object was stored — every value `unknown`, and `{}` when
   * the row is absent or unreadable — and must return a value this build
   * trusts, field by field. There is no way to call this without saying how
   * the value is checked, which is the point: the one setting that was ever
   * trusted as stored was `overlayOptIn`, the consent to speak over someone
   * else's audio, and a stored string `"false"` read as yes.
   *
   * `corrected` is true when a row existed and `normalize` changed it, so a
   * store can write the healed value back. It is false for an absent row —
   * a fresh install writes nothing just by loading.
   */
  readChecked<T extends object>(
    key: SettingsKey,
    normalize: (stored: Record<string, unknown>) => T,
  ): { value: T; corrected: boolean } {
    const stored = this.readObject(key)
    const value = normalize(stored ?? {})
    return {
      value,
      corrected: stored !== null && JSON.stringify(value) !== JSON.stringify(stored),
    }
  }

  /**
   * Read one setting, merged over `fallback`, WITHOUT checking its values.
   *
   * @deprecated Use {@link readChecked}. The type parameter here is a hope,
   * not a check. Only the instrument settings store still calls this, and
   * `settingsReadsAreChecked.test.ts` fails if anything else starts to.
   */
  read<T extends object>(key: SettingsKey, fallback: T): T {
    const stored = this.readObject(key)
    // Fallback first: a key added since this row was written keeps its
    // default rather than arriving undefined.
    return stored === null ? fallback : { ...fallback, ...(stored as Partial<T>) }
  }

  write(key: SettingsKey, value: object, nowIso = new Date().toISOString()): void {
    this.run(
      `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                        updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), nowIso],
    )
  }

  /** Remove a setting, returning it to its default. */
  clear(key: SettingsKey): void {
    this.run('DELETE FROM app_settings WHERE key = ?', [key])
  }

  /* -- internals -------------------------------------------------------- */

  /** The stored object, or null when the row is absent or not an object. */
  private readObject(key: SettingsKey): Record<string, unknown> | null {
    const rows = this.select<RawSetting>('SELECT value_json FROM app_settings WHERE key = ?', [key])
    const raw = rows[0]?.value_json
    if (raw === undefined) return null

    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(
          `expected an object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
        )
      }
      return parsed as Record<string, unknown>
    } catch (err) {
      logger.warn('storage.settings.unreadable', 'stored setting ignored; using defaults', {
        key: safe(key),
        error: safe(String(err)),
      })
      return null
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

  private select<T>(sql: string, params: SqlBindValue[]): T[] {
    const stmt = this.db.prepareSync(sql)
    try {
      return stmt.executeSync<T>(params).getAllSync()
    } finally {
      stmt.finalizeSync()
    }
  }
}
