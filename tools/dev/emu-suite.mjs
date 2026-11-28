#!/usr/bin/env node
/**
 * emu-suite — the tablet's verify suite on an Android emulator, in one command.
 *
 *   npm run emu:suite                                  all 22, numbers, whole workouts
 *   npm run emu:suite -- --only=quick-one-two --first-round-only
 *   npm run emu:suite -- --vocab=both --out=tools/analysis/suites/<name>
 *   npm run emu:suite -- --dry-run                     say what it would do
 *   npm run emu:prepare                                give a worktree its android/ project
 *
 * Why this exists. The tablet's tests run on the emulator (the owner's rule,
 * 2026-11-28), and doing that by hand is nine steps with three traps in them:
 * a prompt that holds the workout, a switch that only a tap in Settings can
 * turn on, and a build that can quietly be the wrong checkout's. This does
 * them in order and stops, with a reason, where one cannot be done.
 *
 * What it does:
 *   1. starts the emulator if it is not up, and checks that the device on
 *      that port really is the AVD it expects — never another project's;
 *   2. builds an x86_64 release APK from THIS checkout's `android/` when the
 *      one on disk was built from another commit. It stops if `android/` is
 *      missing or the tree is dirty: it never falls back to another checkout,
 *      and it never builds a commit id that does not describe the code;
 *   3. installs it when the device's copy differs;
 *   4. grants the two Bluetooth permissions, so no prompt appears over the
 *      live screen (there is no adapter; the scan finds nothing, quietly);
 *   5. switches QA mode on by writing its one settings row as root;
 *   6. runs `tools/analysis/verify-suite.mjs` against it with
 *      `--expect-release --require-sha`, passing the other arguments through;
 *   7. stops the emulator, if it was the one that started it.
 *
 * Step 5 is the one that needs saying. A link can use QA mode and can never
 * switch it on — that door was closed on purpose (`src/app/qa/run.tsx`).
 * Writing the row needs root on the device, which a tablet does not give and
 * a link can never have, so the door stays closed. This script refuses any
 * device that is not an emulator.
 *
 * What an emulator's run means: `docs/dev-setup.md`, "An Android emulator".
 * Its timing figures are this PC's. No tablet constant is set from them.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isEmulatorDevice } from '../analysis/verify-suite.mjs'
import { devicesFromAdb, PACKAGE, sawReady } from './reload-tablet.mjs'

export const DEFAULT_AVD = 'punchcraft-emu'
/** 5554 is the first emulator's port, and on this PC that is another project's. */
export const DEFAULT_PORT = 5556
export const ARCH = 'x86_64'
export const DATABASE = `/data/data/${PACKAGE}/files/SQLite/punchcraft.db`
export const BLUETOOTH_PERMISSIONS = [
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
]
/** `src/storage/migrations/006_app_settings.ts` and `SETTINGS_KEYS.qa`. */
export const QA_KEY = 'qa.mode'
export const QA_VALUE = '{"enabled":true}'

// Under jest the module is transformed and `import.meta.url` is empty; the
// tests only reach the pure functions, so the working directory will do.
const THIS_FILE = import.meta.url ? fileURLToPath(import.meta.url) : null
const REPO_ROOT = THIS_FILE ? resolve(dirname(THIS_FILE), '..', '..') : process.cwd()

// ---------------------------------------------------------------------------
// Pure helpers (jest-guarded in __tests__/emu-suite.test.js)
// ---------------------------------------------------------------------------

/**
 * Flags → this script's options, and everything else for the verify suite.
 *
 * `--device` is refused: the device is the emulator this script manages, and
 * a second answer to "which device" is how a run lands on the wrong one.
 */
export function parseArgs(argv) {
  const opts = {
    prepare: false,
    dryRun: false,
    build: true,
    keepRunning: false,
    avd: DEFAULT_AVD,
    port: DEFAULT_PORT,
    bootTimeoutMs: 300_000,
    /** @type {string[]} */
    suiteArgs: [],
  }
  for (const arg of argv) {
    if (arg === '--prepare') opts.prepare = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--no-build') opts.build = false
    else if (arg === '--keep-running') opts.keepRunning = true
    else if (arg.startsWith('--avd=')) opts.avd = arg.slice('--avd='.length)
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length))
    else if (arg === '--device' || arg.startsWith('--device=')) {
      throw new Error('--device is not taken here: the device is the emulator on --port')
    } else opts.suiteArgs.push(arg)
  }
  if (!/^[\w.-]+$/.test(opts.avd)) throw new Error(`--avd must be an AVD name, got '${opts.avd}'`)
  if (!Number.isInteger(opts.port) || opts.port < 5556 || opts.port > 5682 || opts.port % 2 !== 0) {
    throw new Error(`--port must be an even emulator port from 5556 to 5682, got ${opts.port}`)
  }
  return opts
}

/** The serial adb gives the emulator on a console port. */
export function serialFor(port) {
  return `emulator-${port}`
}

/** No window, no snapshot: every start is the same cold device. */
export function emulatorArgs({ avd, port }) {
  return [
    '-avd',
    avd,
    '-no-window',
    '-no-snapshot',
    '-no-boot-anim',
    '-gpu',
    'host',
    '-port',
    String(port),
  ]
}

/** The AVD name from `adb emu avd name`, which prints the name and then `OK`. */
export function avdNameFrom(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== 'OK')
  return lines[0] ?? null
}

/**
 * Why the device on this port may not be used, or `null` when it may.
 *
 * Two questions: is it an emulator at all, and is it the AVD asked for. The
 * second matters on a PC with more than one — the other one here belongs to
 * another project and had its own app in front.
 */
export function deviceRefusal({ serial, isEmulator, avdName, expectedAvd }) {
  if (!isEmulator)
    return `${serial} is not an emulator — this command switches QA mode on as root and is for emulators only`
  if (avdName !== expectedAvd)
    return `${serial} is the AVD '${avdName ?? 'unknown'}', not '${expectedAvd}' — it is left alone`
  return null
}

/** Whether the APK on disk has to be rebuilt to be this commit's. */
export function needsBuild({ apkExists, builtFrom, head }) {
  if (!apkExists) return true
  if (!builtFrom || !head || head === 'unknown') return true
  return builtFrom.sha !== head || builtFrom.arch !== ARCH
}

/** Gradle's wrapper — its file name in `android/` — differs by platform; the arguments do not. */
export function gradleInvocation(platform) {
  return {
    command: platform === 'win32' ? 'gradlew.bat' : 'gradlew',
    args: ['assembleRelease', `-PreactNativeArchitectures=${ARCH}`, '--console=plain'],
  }
}

/**
 * The verify suite's arguments: this emulator, a release build, and this
 * commit — then whatever was asked for, with `--all` when nothing was picked.
 */
export function suiteArguments(passed, serial) {
  const picked = passed.some((a) => a === '--all' || a.startsWith('--only='))
  return [
    `--device=${serial}`,
    '--expect-release',
    '--require-sha',
    ...(picked ? [] : ['--all']),
    ...passed,
  ]
}

/**
 * The SQL that switches QA mode on, and reads it back.
 *
 * The same upsert `SettingsRepository.write` makes. The checkpoint folds the
 * write-ahead log back into the database file, so no `-wal` is left behind
 * owned by root for the app to trip over.
 */
export function qaModeSql(updatedAtIso) {
  return [
    `INSERT INTO app_settings (key, value_json, updated_at) VALUES ('${QA_KEY}', '${QA_VALUE}', '${updatedAtIso}')`,
    '  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at;',
    'PRAGMA wal_checkpoint(TRUNCATE);',
    `SELECT 'qa=' || value_json FROM app_settings WHERE key = '${QA_KEY}';`,
    '',
  ].join('\n')
}

/** Whether sqlite's answer to `qaModeSql` says the row now reads "on". */
export function qaModeIsOn(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .some((line) => line.trim() === `qa=${QA_VALUE}`)
}

/**
 * Files in an `ls -ln` listing that root owns.
 *
 * A file root creates in the app's directory has root's owner and none of the
 * app's SELinux categories; the app then cannot open its own database. This
 * is the check that it did not happen.
 */
export function rootOwned(lsText) {
  const owned = []
  for (const line of String(lsText ?? '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 8 || !/^[-dl]/.test(cols[0])) continue
    if (cols[2] === '0') owned.push(cols[cols.length - 1])
  }
  return owned
}

/** Whether `dumpsys package` shows a runtime permission as granted. */
export function grantedIn(dumpsysText, permission) {
  return String(dumpsysText ?? '')
    .split(/\r?\n/)
    .some((line) => line.includes(`${permission}:`) && /granted=true/.test(line))
}

/**
 * Whether a path inside `android/` is source to copy, or build output to
 * leave. `relativePath` is from `android/`, with either separator.
 */
export function isAndroidSource(relativePath) {
  const parts = relativePath.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0) return true
  if (['build', '.gradle', '.kotlin'].includes(parts[0])) return false
  if (parts[0] === 'app' && ['build', '.cxx'].includes(parts[1] ?? '')) return false
  return true
}

/** The first field of `sha256sum`'s output. */
export function shaFromSum(text) {
  const match = /^([0-9a-f]{64})\b/m.exec(String(text ?? '').trim())
  return match ? match[1] : null
}

// ---------------------------------------------------------------------------
// Everything below touches the machine or the device.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const say = (message) => console.log(`[emu] ${message}`)

class Stop extends Error {}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const adb = (serial, ...args) => run('adb', ['-s', serial, ...args])
const shell = (serial, command) => adb(serial, 'shell', command)

function git(...args) {
  return run('git', args, { cwd: REPO_ROOT }).stdout.trim()
}

function emulatorBinary() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
  if (!sdk) throw new Stop('ANDROID_HOME is not set, so the emulator cannot be found')
  const binary = join(sdk, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator')
  if (!existsSync(binary)) throw new Stop(`no emulator at ${binary}`)
  return binary
}

async function waitForBoot(serial, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (shell(serial, 'getprop sys.boot_completed').stdout.trim() === '1') return
    await sleep(2_000)
  }
  throw new Stop(`${serial} did not finish booting in ${Math.round(timeoutMs / 1000)} s`)
}

/** Start the emulator if nothing is on its port. Returns whether this call started it. */
async function ensureEmulator(opts, serial) {
  const up = devicesFromAdb(run('adb', ['devices']).stdout).includes(serial)
  if (!up) {
    say(`starting ${opts.avd} on port ${opts.port}`)
    mkdirSync(join(REPO_ROOT, 'artifacts'), { recursive: true })
    const log = openSync(join(REPO_ROOT, 'artifacts', `emulator-${opts.port}.log`), 'a')
    const child = spawn(emulatorBinary(), emulatorArgs(opts), {
      detached: true,
      stdio: ['ignore', log, log],
    })
    child.unref()
    closeSync(log)
    run('adb', ['-s', serial, 'wait-for-device'], { timeout: opts.bootTimeoutMs })
  }
  await waitForBoot(serial, opts.bootTimeoutMs)
  const refusal = deviceRefusal({
    serial,
    isEmulator: isEmulatorDevice({
      serial,
      qemu: shell(serial, 'getprop ro.kernel.qemu').stdout,
      characteristics: shell(serial, 'getprop ro.build.characteristics').stdout,
    }),
    avdName: avdNameFrom(adb(serial, 'emu', 'avd', 'name').stdout),
    expectedAvd: opts.avd,
  })
  if (refusal) throw new Stop(refusal)
  return !up
}

const apkPath = () =>
  join(REPO_ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
const builtFromPath = () => join(dirname(apkPath()), 'built-from.json')

function readBuiltFrom() {
  try {
    return JSON.parse(readFileSync(builtFromPath(), 'utf8'))
  } catch {
    return null
  }
}

function ensureBuild(opts) {
  const head = git('rev-parse', '--short', 'HEAD') || 'unknown'
  if (!opts.build) {
    if (!existsSync(apkPath())) throw new Stop(`--no-build, and there is no APK at ${apkPath()}`)
    say(
      `--no-build: using the APK on disk (built from ${readBuiltFrom()?.sha ?? 'an unknown commit'}; HEAD is ${head})`,
    )
    return head
  }
  const androidDir = join(REPO_ROOT, 'android')
  if (!existsSync(join(androidDir, 'app', 'build.gradle'))) {
    throw new Stop(
      `this checkout has no android/ project (${androidDir}). Run \`npm run emu:prepare\` — it is never built from another checkout`,
    )
  }
  const dirty = git('status', '--porcelain')
  if (dirty !== '') {
    throw new Stop(
      'the working tree has uncommitted changes. The build names its commit, and that id would not describe this code — commit first, or pass --no-build',
    )
  }
  if (!needsBuild({ apkExists: existsSync(apkPath()), builtFrom: readBuiltFrom(), head })) {
    say(`the APK on disk is already ${head}`)
    return head
  }
  say(`building ${head} for ${ARCH} — a few minutes cold, about a minute after a JS-only change`)
  // One command line for the shell: by its full path, quoted (a shell does
  // not look for the wrapper in the directory it was started in, and a .bat
  // cannot be run without one). The arguments are fixed strings from here.
  const { command, args } = gradleInvocation(process.platform)
  const result = spawnSync(`"${join(androidDir, command)}" ${args.join(' ')}`, {
    cwd: androidDir,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      .split(/\r?\n/)
      .slice(-40)
      .join('\n')
    throw new Stop(`the build failed:\n${tail}`)
  }
  writeFileSync(
    builtFromPath(),
    JSON.stringify({ sha: head, arch: ARCH, at: new Date().toISOString() }, null, 2) + '\n',
  )
  return head
}

function sha256Of(file) {
  const hash = createHash('sha256')
  const fd = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function ensureInstalled(serial) {
  const installed = shell(serial, `pm path ${PACKAGE}`)
    .stdout.trim()
    .replace(/^package:/, '')
  if (
    installed !== '' &&
    shaFromSum(shell(serial, `sha256sum ${installed}`).stdout) === sha256Of(apkPath())
  ) {
    say('the device already has this APK')
    return
  }
  say('installing')
  const result = adb(serial, 'install', '-r', apkPath())
  if (!/Success/.test(result.stdout))
    throw new Stop(`install failed: ${(result.stdout + result.stderr).trim().split(/\r?\n/).pop()}`)
}

function grantBluetooth(serial) {
  for (const permission of BLUETOOTH_PERMISSIONS) shell(serial, `pm grant ${PACKAGE} ${permission}`)
  const dump = shell(serial, `dumpsys package ${PACKAGE}`).stdout
  const missing = BLUETOOTH_PERMISSIONS.filter((permission) => !grantedIn(dump, permission))
  if (missing.length > 0)
    throw new Stop(`could not grant ${missing.join(', ')} — a prompt would hold the workout`)
}

async function waitForReady(serial, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sawReady(adb(serial, 'logcat', '-d', '-s', 'ReactNativeJS:V').stdout)) return
    await sleep(1_000)
  }
  throw new Stop('the app never logged that it was ready, so its database may not exist yet')
}

async function asRoot(serial, work) {
  adb(serial, 'root')
  run('adb', ['-s', serial, 'wait-for-device'], { timeout: 60_000 })
  if (shell(serial, 'whoami').stdout.trim() !== 'root')
    throw new Stop('adb root did not take — is this a userdebug image?')
  try {
    return await work()
  } finally {
    adb(serial, 'unroot')
    run('adb', ['-s', serial, 'wait-for-device'], { timeout: 60_000 })
  }
}

/**
 * Switch QA mode on. The app must have run once — migration 006 creates the
 * table on first open — and must be stopped while the row is written.
 */
async function enableQaMode(serial) {
  await asRoot(serial, async () => {
    if (shell(serial, `ls ${DATABASE}`).status !== 0) {
      say('first launch: letting the app create its database')
      adb(serial, 'logcat', '-c')
      shell(serial, `monkey -p ${PACKAGE} -c android.intent.category.LAUNCHER 1`)
      await waitForReady(serial, 120_000)
    }
    shell(serial, `am force-stop ${PACKAGE}`)
    const written = run('adb', ['-s', serial, 'shell', 'sqlite3', DATABASE], {
      input: qaModeSql(new Date().toISOString()),
    })
    if (!qaModeIsOn(written.stdout))
      throw new Stop(`QA mode did not read back as on: ${(written.stdout + written.stderr).trim()}`)
    const directory = dirname(DATABASE)
    const listing = () => shell(serial, `ls -ln ${directory}`).stdout
    if (rootOwned(listing()).length > 0) {
      // Give them back rather than leave the app unable to open its own files.
      const owner = shell(serial, `stat -c %u:%g ${DATABASE}`).stdout.trim()
      shell(serial, `chown ${owner} ${directory}/*`)
      shell(serial, `restorecon -R ${directory}`)
    }
    const left = rootOwned(listing())
    if (left.length > 0)
      throw new Stop(`root still owns ${left.join(', ')} in the app's database folder`)
  })
  say('QA mode is on')
}

function runSuite(opts, serial) {
  const args = [
    join(REPO_ROOT, 'tools', 'analysis', 'verify-suite.mjs'),
    ...suiteArguments(opts.suiteArgs, serial),
  ]
  say(`node ${relative(REPO_ROOT, args[0]).split(sep).join('/')} ${args.slice(1).join(' ')}`)
  return spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit' }).status ?? 1
}

/**
 * Give a worktree its `android/` project: the main checkout's, without its
 * build output. A worktree has none of its own — the folder is git-ignored —
 * and building the main checkout's instead would ship the main checkout's
 * code under this one's name.
 */
function prepare() {
  const target = join(REPO_ROOT, 'android')
  if (existsSync(join(target, 'app', 'build.gradle'))) {
    say(`this checkout already has an android/ project (${target})`)
    return 0
  }
  const common = resolve(REPO_ROOT, git('rev-parse', '--git-common-dir'))
  const main = dirname(common)
  if (resolve(main) === resolve(REPO_ROOT))
    throw new Stop(
      'this is the main checkout and it has no android/ project — there is nothing to copy it from',
    )
  const source = join(main, 'android')
  if (!existsSync(join(source, 'app', 'build.gradle')))
    throw new Stop(`the main checkout has no android/ project either (${source})`)
  say(`copying ${source} → ${target}, without its build output`)
  cpSync(source, target, {
    recursive: true,
    filter: (from) => isAndroidSource(relative(source, from)),
  })
  // The native project was generated from the main checkout's config. Where
  // that differs from this checkout's, the build may not be what this
  // checkout's config describes.
  const differing = ['app.config.ts', 'package.json', 'package-lock.json'].filter((name) => {
    const here = join(REPO_ROOT, name)
    const there = join(main, name)
    return existsSync(here) && existsSync(there) && !readFileSync(here).equals(readFileSync(there))
  })
  if (differing.length > 0) {
    say(
      `note: ${differing.join(', ')} differ${differing.length === 1 ? 's' : ''} between this checkout and ${main}. The native project came from there; if the difference is a native dependency or the app config's native fields, this build will not have it.`,
    )
  }
  return 0
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.prepare) return prepare()
  const serial = serialFor(opts.port)
  if (opts.dryRun) {
    say(`would use ${serial} (AVD ${opts.avd}), starting it if it is not up`)
    say(
      opts.build
        ? `would build ${ARCH} from ${join(REPO_ROOT, 'android')} if the APK is not HEAD's`
        : 'would not build',
    )
    say('would install the APK if the device has another, grant Bluetooth, switch QA mode on')
    say(`would run: verify-suite ${suiteArguments(opts.suiteArgs, serial).join(' ')}`)
    return 0
  }
  // Build first: it needs no device, and a refusal here costs nothing.
  ensureBuild(opts)
  const started = await ensureEmulator(opts, serial)
  try {
    ensureInstalled(serial)
    grantBluetooth(serial)
    await enableQaMode(serial)
    return runSuite(opts, serial)
  } finally {
    if (started && !opts.keepRunning) {
      say(`stopping ${serial}`)
      adb(serial, 'emu', 'kill')
    }
  }
}

if (THIS_FILE && resolve(process.argv[1] ?? '') === THIS_FILE) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      if (!(error instanceof Stop)) throw error
      console.error(`[emu] stopped: ${error.message}`)
      process.exit(3)
    },
  )
}
