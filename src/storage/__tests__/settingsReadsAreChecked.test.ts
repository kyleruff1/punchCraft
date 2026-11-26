/**
 * A stored setting cannot be read without being checked.
 *
 * `SettingsRepository` has two reads. `readChecked` takes a function that
 * validates the stored object field by field; `read` merges it over a
 * fallback and believes it. The second one is how `overlayOptIn` — the
 * consent to speak over someone else's audio — was once trusted as stored,
 * so that a string `"false"` in the row read as yes.
 *
 * Every setting the workouts app reads now goes through `readChecked`.
 * This walks the source so the next one does too: a file added tomorrow is
 * covered by existing, and "I'll validate it later" does not type-check its
 * way past CI.
 *
 * The instrument settings store is the one exception. It is Puncheoke's
 * code, which is not ours to rework, and it still calls `read`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

import { SETTINGS_KEYS } from '@storage/migrations/006_app_settings'

const ALLOWED = new Set([
  // Defines both reads.
  ['src', 'storage', 'repositories', 'SettingsRepository.ts'].join(sep),
  // Puncheoke's, and left as it is.
  ['src', 'state', 'useInstrumentSettingsStore.ts'].join(sep),
])

function sources(dir = 'src'): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__') continue
      found.push(...sources(path))
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      found.push(path)
    }
  }
  return found
}

/** Comments out, so prose that mentions `.read(` is not a call. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** `.read(` or `.read<T>(` — the unchecked read, however it is wrapped. */
const UNCHECKED_READ = /\.read\s*(?:<[^>()]*>)?\s*\(/

describe('stored settings are read through readChecked', () => {
  const offenders = sources().filter(
    (path) => !ALLOWED.has(path) && UNCHECKED_READ.test(code(readFileSync(path, 'utf8'))),
  )

  it('finds no unchecked read outside the instrument store', () => {
    expect(offenders).toEqual([])
  })

  it('would notice one — the instrument store is the proof', () => {
    // The scan is only worth trusting if it can see the thing it bans.
    const instrument = readFileSync(
      ['src', 'state', 'useInstrumentSettingsStore.ts'].join(sep),
      'utf8',
    )
    expect(UNCHECKED_READ.test(code(instrument))).toBe(true)
  })

  it('reads every non-instrument key somewhere through readChecked', () => {
    const all = sources()
      .map((path) => code(readFileSync(path, 'utf8')))
      .join('\n')
    const keys = (Object.keys(SETTINGS_KEYS) as Array<keyof typeof SETTINGS_KEYS>).filter(
      (key) => !key.startsWith('instrument'),
    )
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      const checked = new RegExp(
        String.raw`readChecked\s*(?:<[^>()]*>)?\s*\(\s*SETTINGS_KEYS\.${key}\b`,
      )
      expect([key, checked.test(all)]).toEqual([key, true])
    }
  })
})
