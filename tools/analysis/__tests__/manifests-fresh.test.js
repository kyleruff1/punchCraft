/**
 * The committed verifier manifests are what the generator produces today.
 *
 * `tools/analysis/manifests/*.json` is the ground truth the first-round
 * verifier judges a drive against: which clip, when, for every workout. It
 * is generated from the app's own code (`first-round-manifest.ts`), and
 * nothing checked that it had been regenerated after that code changed.
 *
 * It had not. On 2026-11-27 ten of the 44 files were found stale — since
 * `0b81c660` in September, which retimed one family of calls on purpose and
 * did not regenerate; later clip re-renders moved more. The next suite drive
 * would have judged six workouts' lead-ins against times the app no longer
 * uses. Found only because a refactor needed "regenerate and see nothing
 * change" as its proof.
 *
 * If this fails: the code moved, so regenerate —
 *   node --import ./tools/analysis/wav-stub.mjs --import tsx \
 *     tools/analysis/first-round-manifest.ts --all
 *   …and again with --vocab=techniques
 * — and read the diff before committing it. A change you did not expect is
 * a timing regression, not a stale file.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { listSampleWorkouts } from '../../../src/domain/workout/samples'
import { buildFirstRoundManifest } from '../first-round-manifest'

const DIR = path.join(process.cwd(), 'tools', 'analysis', 'manifests')
const fileFor = (key, vocabulary) =>
  path.join(DIR, vocabulary === 'numbers' ? `${key}.json` : `${key}.techniques.json`)

/** The first place two JSON values differ, as a path — a 3,000-line diff helps nobody. */
function firstDifference(a, b, at = '') {
  if (Object.is(a, b)) return null
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return `${at || '(root)'}: committed ${JSON.stringify(b)} · generated ${JSON.stringify(a)}`
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    const found = firstDifference(a[key], b[key], at ? `${at}.${key}` : key)
    if (found) return found
  }
  return null
}

const KEYS = listSampleWorkouts().map((s) => s.key)

describe('the committed verifier manifests', () => {
  it('cover every library workout, in both vocabularies', () => {
    expect(KEYS).toHaveLength(22)
    for (const key of KEYS) {
      expect(existsSync(fileFor(key, 'numbers'))).toBe(true)
      expect(existsSync(fileFor(key, 'techniques'))).toBe(true)
    }
  })

  describe.each(['numbers', 'techniques'])('%s', (vocabulary) => {
    it.each(KEYS)('%s is what the generator produces today', (key) => {
      const committed = JSON.parse(readFileSync(fileFor(key, vocabulary), 'utf8'))
      // Through JSON, as the generator writes it: no undefined, no class instances.
      const generated = JSON.parse(JSON.stringify(buildFirstRoundManifest(key, vocabulary)))
      expect(firstDifference(generated, committed)).toBeNull()
    })
  })
})
