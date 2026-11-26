#!/usr/bin/env node
/**
 * reload-tablet — restart Metro, cold-restart the app, wait for it to come up.
 *
 *   npm run tablet:reload
 *   npm run tablet:reload -- --no-metro      # only restart the app
 *   npm run tablet:reload -- --dry-run       # say what it would do
 *
 * Why this exists. The repo lives on F:, and Metro cannot watch F:, so fast
 * refresh never fires. Every batch of edits needs Metro restarted AND the app
 * cold-restarted before the tablet runs the new code; skip either and you are
 * testing the old bundle, usually without noticing. This does both, in the
 * right order, and waits for the app to say it is up.
 *
 * What it does:
 *   1. finds whatever is listening on Metro's port and stops it — only if it
 *      is a `node` process; anything else is reported and left alone;
 *   2. starts `expo start --dev-client`, detached, logging to
 *      artifacts/metro.log, and waits for Metro to answer;
 *   3. force-stops the app, clears logcat, relaunches it;
 *   4. waits for the app's own `workout.app.ready` record.
 *
 * STATUS — unproven end to end. Written 2026-11-25 with no tablet attached:
 * the pure parts are unit-tested and `--dry-run` was exercised, but steps 3-4
 * have not been watched working on the device. Trust it after the first run
 * you see succeed, not before.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE = 'com.kyleruff.punchcraft'
export const DEFAULT_PORT = 8081
export const READY_RECORD = 'workout.app.ready'

// Under jest the module is transformed and `import.meta.url` is empty; the
// tests only reach the pure functions, so the working directory will do.
const THIS_FILE = import.meta.url ? fileURLToPath(import.meta.url) : null
const REPO_ROOT = THIS_FILE ? resolve(dirname(THIS_FILE), '..', '..') : process.cwd()

/** Flags → options. Unknown flags are an error, not a silent no-op. */
export function parseArgs(argv) {
  const opts = {
    metro: true,
    dryRun: false,
    port: DEFAULT_PORT,
    device: undefined,
    metroTimeoutMs: 120_000,
    readyTimeoutMs: 180_000,
  }
  for (const arg of argv) {
    if (arg === '--no-metro') opts.metro = false
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length))
    else if (arg.startsWith('--device=')) opts.device = arg.slice('--device='.length)
    else if (arg.startsWith('--ready-timeout=')) {
      opts.readyTimeoutMs = Number(arg.slice('--ready-timeout='.length)) * 1000
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65_535) {
    throw new Error(`--port must be a port number, got ${opts.port}`)
  }
  if (!Number.isFinite(opts.readyTimeoutMs) || opts.readyTimeoutMs <= 0) {
    throw new Error('--ready-timeout must be a positive number of seconds')
  }
  return opts
}

/**
 * PIDs listening on `port`, from `netstat -ano` output (Windows).
 *
 *   TCP    0.0.0.0:8081    0.0.0.0:0    LISTENING    12345
 *   TCP    [::]:8081       [::]:0       LISTENING    12345
 */
export function listenersFromNetstat(text, port) {
  const pids = new Set()
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue
    if (!cols[1].endsWith(`:${port}`)) continue
    const pid = Number(cols[4])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/** The image name for a PID, from `tasklist /FI "PID eq n" /FO CSV /NH`. */
export function imageNameFromTasklist(text) {
  const match = /^"([^"]+)"/m.exec(text.trim())
  return match ? match[1] : null
}

/** Only ever stop a Node process: that is what Metro is. */
export function isNodeImage(name) {
  return typeof name === 'string' && /^node(\.exe)?$/i.test(name.trim())
}

/** Serial numbers of devices in the `device` state, from `adb devices`. */
export function devicesFromAdb(text) {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[1] === 'device')
    .map((cols) => cols[0])
}

/** Metro's /status endpoint answers with exactly this when it is serving. */
export function metroIsUp(body) {
  return typeof body === 'string' && body.includes('packager-status:running')
}

/** Whether logcat output contains the app's ready record. */
export function sawReady(logcatText) {
  return typeof logcatText === 'string' && logcatText.includes(READY_RECORD)
}

// ---------------------------------------------------------------------------
// Everything below touches the machine or the device.
// ---------------------------------------------------------------------------

const say = (msg) => console.log(`[reload] ${msg}`)
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function adb(deviceId, ...args) {
  return run('adb', deviceId ? ['-s', deviceId, ...args] : args)
}

function metroListeners(port) {
  if (process.platform === 'win32') {
    return listenersFromNetstat(run('netstat', ['-ano', '-p', 'TCP']).stdout ?? '', port)
  }
  const out = run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).stdout ?? ''
  return out.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
}

function imageName(pid) {
  if (process.platform === 'win32') {
    return imageNameFromTasklist(
      run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).stdout ?? '',
    )
  }
  return (run('ps', ['-p', String(pid), '-o', 'comm=']).stdout ?? '').trim().split('/').pop() || null
}

function stopProcessTree(pid) {
  if (process.platform === 'win32') run('taskkill', ['/PID', String(pid), '/T', '/F'])
  else run('kill', ['-TERM', String(pid)])
}

async function metroAnswers(port) {
  try {
    const response = await fetch(`http://localhost:${port}/status`)
    return metroIsUp(await response.text())
  } catch {
    return false
  }
}

async function waitFor(check, timeoutMs, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(everyMs)
  }
  return false
}

async function restartMetro(opts) {
  for (const pid of metroListeners(opts.port)) {
    const name = imageName(pid)
    if (!isNodeImage(name)) {
      throw new Error(
        `port ${opts.port} is held by ${name ?? 'an unknown process'} (pid ${pid}), not node. ` +
          'Not stopping it; free the port or pass --port.',
      )
    }
    say(`stopping Metro (node, pid ${pid})`)
    if (!opts.dryRun) stopProcessTree(pid)
  }
  if (opts.dryRun) {
    say(`would start: npx expo start --dev-client --port ${opts.port}`)
    return
  }
  await waitFor(() => metroListeners(opts.port).length === 0, 15_000, 500)

  const logPath = join(REPO_ROOT, 'artifacts', 'metro.log')
  mkdirSync(dirname(logPath), { recursive: true })
  const log = openSync(logPath, 'w')
  const child = spawn('npx', ['expo', 'start', '--dev-client', '--port', String(opts.port)], {
    cwd: REPO_ROOT,
    detached: true,
    shell: process.platform === 'win32',
    stdio: ['ignore', log, log],
    windowsHide: true,
  })
  child.unref()
  closeSync(log)
  say(`Metro starting (pid ${child.pid}); log: artifacts/metro.log`)
  if (!(await waitFor(() => metroAnswers(opts.port), opts.metroTimeoutMs))) {
    throw new Error(`Metro did not answer on port ${opts.port}; see artifacts/metro.log`)
  }
  say('Metro is up')
}

async function restartApp(opts) {
  const devices = devicesFromAdb(adb(undefined, 'devices').stdout ?? '')
  const device = opts.device ?? devices[0]
  if (!device || (opts.device && !devices.includes(opts.device))) {
    throw new Error(
      `no tablet attached (adb devices lists: ${devices.join(', ') || 'nothing'}). ` +
        'Connect it over wireless adb and run again.',
    )
  }
  if (opts.dryRun) {
    say(`would cold-restart ${PACKAGE} on ${device} and wait for ${READY_RECORD}`)
    return
  }
  say(`cold-restarting ${PACKAGE} on ${device}`)
  adb(device, 'shell', 'am', 'force-stop', PACKAGE)
  adb(device, 'logcat', '-c')
  adb(device, 'shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1')

  const ready = await waitFor(
    () => sawReady(adb(device, 'logcat', '-d', '-s', 'ReactNativeJS:V').stdout ?? ''),
    opts.readyTimeoutMs,
    1500,
  )
  if (!ready) {
    throw new Error(
      `${READY_RECORD} was not logged within ${opts.readyTimeoutMs / 1000}s. ` +
        'Is the dev-launcher picker showing, or Metro unreachable from the tablet?',
    )
  }
  say('the app is up on the new bundle')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.metro) await restartMetro(opts)
  await restartApp(opts)
}

if (THIS_FILE && process.argv[1] && resolve(process.argv[1]) === THIS_FILE) {
  main().catch((err) => {
    console.error(`[reload] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
