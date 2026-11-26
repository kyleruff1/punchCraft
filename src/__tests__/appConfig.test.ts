/**
 * Things `app.config.ts` must say for a CLEAN checkout to build.
 *
 * The native `android/` tree is generated and git-ignored, and the one on the
 * workstation has been patched by hand for months. So a config that cannot
 * rebuild that tree goes unnoticed until someone — or CI — starts from
 * nothing. The first CI release build did (2026-11-26), and failed.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import config from '../../app.config'

// Jest runs from the repository root.
const ROOT = process.cwd()

type Plugin = string | [string, Record<string, unknown>?]
const plugin = (name: string): Record<string, unknown> | undefined => {
  const found = (config.plugins as Plugin[]).find((p) => (Array.isArray(p) ? p[0] : p) === name)
  return Array.isArray(found) ? (found[1] ?? {}) : found === undefined ? undefined : {}
}

describe('app.config', () => {
  it('gives the splash screen an image that is in the repo', () => {
    // Prebuild always writes a style pointing at `@drawable/splashscreen_logo`
    // and only generates that drawable from `image`. Without one the release
    // build fails at resource linking.
    const splash = plugin('expo-splash-screen')
    expect(splash).toBeDefined()
    expect(typeof splash?.['image']).toBe('string')
    expect(existsSync(join(ROOT, String(splash?.['image'])))).toBe(true)
  })

  it('points the icons at files that are in the repo', () => {
    expect(existsSync(join(ROOT, String(config.icon)))).toBe(true)
    expect(existsSync(join(ROOT, String(config.android?.adaptiveIcon?.foregroundImage)))).toBe(true)
  })
})
