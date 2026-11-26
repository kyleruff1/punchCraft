// How the glove check page is bundled. Shared by `serve.mjs`, which serves it,
// and the test that proves the page's whole import graph is browser-safe.
import path from 'node:path'

/**
 * esbuild options for the page.
 *
 * The page imports the app's real protocol code through the repo's path
 * aliases (`@ble/…`, `@protocol/…`), which esbuild reads from the root
 * tsconfig. Nothing in that graph may need React Native — that is the claim
 * the bundle test checks.
 *
 * @param {string} dir the directory holding `main.ts`
 * @returns {import('esbuild').BuildOptions}
 */
export function bundleOptions(dir) {
  return {
    entryPoints: [path.join(dir, 'main.ts')],
    outfile: path.join(dir, 'main.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: 'inline',
    tsconfig: path.join(dir, '..', '..', '..', 'tsconfig.json'),
    logLevel: 'silent',
  }
}
