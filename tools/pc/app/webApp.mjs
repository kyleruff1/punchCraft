// The PC version of the app: build it for a browser, and serve the build on
// this machine only. Shared by `npm run pc:app` and `npm run pc:smoke`.
//
// The build is Expo's ordinary web export — one page, one script, the assets
// beside them — written to `dist/pc-app/` (git-ignored). The server is plain
// node: a static file server with the one rule a single-page app needs.
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// `import.meta.url` is empty when jest transforms this file, and jest runs
// from the repo root.
const here = import.meta.url
  ? path.dirname(fileURLToPath(import.meta.url))
  : path.join(process.cwd(), 'tools', 'pc', 'app')
export const REPO_ROOT = path.resolve(here, '..', '..', '..')
export const OUT_DIR = path.join(REPO_ROOT, 'dist', 'pc-app')
export const HOST = '127.0.0.1'
export const DEFAULT_PORT = 8788

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  // Must be exact: a browser refuses to stream-compile WebAssembly served as
  // anything else, and the database engine is WebAssembly.
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
}

/**
 * Which file answers a request path, or which error.
 *
 * - A file that exists is served.
 * - A path with no extension is one of the app's own screens
 *   (`/settings`, `/punchcraft/live`): the page answers, and the router in
 *   it finds the screen.
 * - A path WITH an extension that is not on disk is a 404. Answering a
 *   missing `.wasm` or `.wav` with the page — as a naive fallback does —
 *   turns "file not found" into a parse error somewhere far away.
 *
 * @param {string} root the build directory
 * @param {string} pathname the request's path, still percent-encoded
 * @returns {{ status: 200, file: string } | { status: 400 | 403 | 404 }}
 */
export function resolveRequest(root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { status: 400 }
  }
  const base = path.resolve(root)
  const file = path.resolve(base, '.' + path.posix.normalize('/' + decoded))
  if (file !== base && !file.startsWith(base + path.sep)) return { status: 403 }
  if (existsSync(file) && statSync(file).isFile()) return { status: 200, file }
  if (path.extname(file) !== '') return { status: 404 }
  const page = path.join(base, 'index.html')
  return existsSync(page) ? { status: 200, file: page } : { status: 404 }
}

/**
 * Serve a build on the loopback address. Resolves once it is listening.
 *
 * @param {{ root?: string, port?: number }} [options] `port: 0` picks a free one
 * @returns {Promise<{ port: number, url: string, close: () => Promise<void> }>}
 */
export function serveWebApp({ root = OUT_DIR, port = DEFAULT_PORT } = {}) {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', `http://${HOST}`)
    const found = resolveRequest(root, pathname)
    if (found.status !== 200) {
      res.writeHead(found.status, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`${found.status}\n`)
      return
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(found.file).toLowerCase()] ?? 'application/octet-stream',
      // A rebuild must be what the next reload shows.
      'Cache-Control': 'no-store',
    })
    createReadStream(found.file).pipe(res)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // The loopback address and nothing else: the app is not reachable from
    // the network, and a loopback page is a secure context (Web Bluetooth,
    // the private file system and the wake lock all need one).
    server.listen(port, HOST, () => {
      const bound = /** @type {import('node:net').AddressInfo} */ (server.address()).port
      resolve({
        port: bound,
        url: `http://${HOST}:${bound}/`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}

/**
 * The commit the checkout is at, spelled as `app.config.ts` spells it for the
 * build: `git rev-parse --short HEAD`, or `unknown` where there is no git.
 */
export function checkoutSha(root = REPO_ROOT) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

// The app config sits in the bundle as JSON inside a string, so its quotes
// may or may not be escaped. Whatever stands between the name and the value,
// it is not a letter or a digit.
const BAKED_SHA = /gitSha[^0-9a-zA-Z]{1,6}([0-9a-f]{4,40}|unknown)[^0-9a-zA-Z]/

/**
 * The commit a build says it is — the `gitSha` baked into its bundle, which is
 * what the app's own build info and its QA run record report. Null when there
 * is no build or it says nothing.
 */
export function builtSha(outDir = OUT_DIR) {
  const scripts = path.join(outDir, '_expo', 'static', 'js', 'web')
  if (!existsSync(scripts)) return null
  for (const file of readdirSync(scripts)) {
    if (!file.endsWith('.js')) continue
    const match = BAKED_SHA.exec(readFileSync(path.join(scripts, file), 'utf8'))
    if (match) return match[1]
  }
  return null
}

/**
 * Build the app for a browser into `outDir`, replacing what was there.
 *
 * The bundler keeps each module's compiled form in a cache, and the app
 * config — the commit id among it — is compiled into one of them. Nothing
 * about that module changes when the config does, so a warm build bakes in
 * whatever commit the cache was filled at: every build from PR 393 until
 * 2026-11-26 said it was `fbffb896`. So the cache is cleared whenever the
 * build on disk is not already the checkout's commit, and the result is
 * checked either way. A build that misnames its commit cannot be tied to the
 * code it was made from, which is the first thing a capture has to prove.
 *
 * @param {{ outDir?: string, quiet?: boolean }} [options]
 * @returns {Promise<void>} rejects with the exporter's exit code
 */
export async function buildWebApp({ outDir = OUT_DIR, quiet = false } = {}) {
  const sha = checkoutSha()
  const stale = builtSha(outDir) !== sha
  // Old builds leave their hashed files behind; clear them — but only ever
  // inside this repo's own `dist/`.
  const dist = path.join(REPO_ROOT, 'dist') + path.sep
  if (!path.resolve(outDir).startsWith(dist)) {
    throw new Error(`refusing to build outside ${dist}: ${outDir}`)
  }
  await rm(outDir, { recursive: true, force: true })
  // The exporter's own entry point, run with this node: no shell, no `npx`.
  const cli = createRequire(path.join(REPO_ROOT, 'package.json')).resolve('expo/bin/cli')
  const args = [cli, 'export', '--platform', 'web', '--output-dir', outDir]
  if (stale) args.push('--clear')
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve(undefined) : reject(new Error(`expo export exited with ${code}`)),
    )
  })
  if (!existsSync(path.join(outDir, 'index.html'))) {
    throw new Error(`expo export finished but wrote no index.html in ${outDir}`)
  }
  const baked = builtSha(outDir)
  if (baked !== sha) {
    throw new Error(`the build says it is commit ${baked}; the checkout is at ${sha}`)
  }
}

/** Whether a build is on disk to serve. */
export const isBuilt = (outDir = OUT_DIR) => existsSync(path.join(outDir, 'index.html'))
