#!/usr/bin/env node
/**
 * emu-suite — the tablet's verify suite on an Android emulator, in one command.
 *
 *   npm run emu:suite                                  all 22, numbers, whole workouts
 *   npm run emu:suite -- --only=quick-one-two --first-round-only
 *   npm run emu:suite -- --vocab=both --out=tools/analysis/suites/<name>
 *   npm run emu:suite -- --vocab=both --jobs=4         four emulators at once
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
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  aggregateVerdicts,
  isEmulatorDevice,
  MANIFESTS_DIR,
  parseArgs as parseSuiteArgs,
  PART_ROWS_DIR,
  planJobs,
  renderSummaryMd,
  SUITES_DIR,
} from '../analysis/verify-suite.mjs'
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
    /** How many emulators drive at once. */
    jobs: 1,
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
    else if (arg.startsWith('--jobs=')) opts.jobs = Number(arg.slice('--jobs='.length))
    else if (arg === '--device' || arg.startsWith('--device=')) {
      throw new Error('--device is not taken here: the device is the emulator on --port')
    } else opts.suiteArgs.push(arg)
  }
  if (!/^[\w.-]+$/.test(opts.avd)) throw new Error(`--avd must be an AVD name, got '${opts.avd}'`)
  if (!Number.isInteger(opts.port) || opts.port < 5556 || opts.port > 5682 || opts.port % 2 !== 0) {
    throw new Error(`--port must be an even emulator port from 5556 to 5682, got ${opts.port}`)
  }
  if (!Number.isInteger(opts.jobs) || opts.jobs < 1 || opts.jobs > 8) {
    throw new Error(`--jobs must be a whole number from 1 to 8, got ${opts.jobs}`)
  }
  if (opts.port + 2 * (opts.jobs - 1) > 5682) {
    throw new Error(`--jobs=${opts.jobs} from port ${opts.port} runs past the last emulator port`)
  }
  return opts
}

/** The serial adb gives the emulator on a console port. */
export function serialFor(port) {
  return `emulator-${port}`
}

/**
 * No window, no snapshot: every start is the same cold device.
 *
 * `readOnly` is how several run at once: a read-only instance shares the
 * AVD's image with the others, boots from the state the last ordinary run
 * left, and throws its own changes away when it stops.
 */
export function emulatorArgs({ avd, port, readOnly = false }) {
  return [
    '-avd',
    avd,
    ...(readOnly ? ['-read-only'] : []),
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

/** The console ports of several instances: the first, and every second one after it. */
export function instancePorts(basePort, jobs) {
  return Array.from({ length: jobs }, (_, index) => basePort + 2 * index)
}

/** Verify-suite arguments that pick the drives or the folder. With several emulators, this script decides those. */
const picksDrives = (arg) =>
  arg === '--all' ||
  arg.startsWith('--only=') ||
  arg.startsWith('--vocab=') ||
  arg.startsWith('--out=')

/**
 * One child's arguments when several emulators share a run: one drive, one
 * emulator, the shared folder, and no summary of its own (`--part`).
 */
export function partArguments(job, serial, runDir, passed) {
  return [
    `--device=${serial}`,
    '--expect-release',
    '--require-sha',
    `--only=${job.workoutId}`,
    `--vocab=${job.vocab}`,
    `--out=${runDir}`,
    '--part',
    ...passed.filter((arg) => !picksDrives(arg)),
  ]
}

/**
 * Whether a drive is worth driving again with nothing else running.
 *
 * Several emulators at once can starve one of them: frames are held, a ring
 * is stepped over, a launch times out. A FAIL or an ERROR found that way is
 * not reported until the drive has had the machine to itself. A build that
 * is the wrong commit is not that kind of failure, and is not re-driven.
 */
export function needsRedrive(row) {
  if (row.verdict !== 'FAIL' && row.verdict !== 'ERROR') return false
  return !String(row.reason ?? '').startsWith('build-mismatch')
}

/** The row to report for a drive that was driven again alone: the second, saying what the first was. */
export function afterRedrive(busyRow, aloneRow) {
  return {
    ...aloneRow,
    redrivenAlone: { verdictWhenBusy: busyRow.verdict, reasonWhenBusy: busyRow.reason ?? null },
  }
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

function stopEmulator(serial) {
  say(`stopping ${serial}`)
  adb(serial, 'emu', 'kill')
}

async function waitUntilGone(serial, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!devicesFromAdb(run('adb', ['devices']).stdout).includes(serial)) return
    await sleep(1_000)
  }
  throw new Stop(`${serial} did not stop`)
}

function startEmulator(opts, port, readOnly) {
  mkdirSync(join(REPO_ROOT, 'artifacts'), { recursive: true })
  const log = openSync(join(REPO_ROOT, 'artifacts', `emulator-${port}.log`), 'a')
  const child = spawn(emulatorBinary(), emulatorArgs({ avd: opts.avd, port, readOnly }), {
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  closeSync(log)
}

/** One drive as its own verify-suite process, its output kept beside its result. */
function drivePart(job, serial, runDir, passed) {
  return new Promise((done) => {
    const rowsDir = join(runDir, PART_ROWS_DIR)
    mkdirSync(rowsDir, { recursive: true })
    const log = openSync(join(rowsDir, `${job.dirName}.log`), 'a')
    const child = spawn(
      process.execPath,
      [
        join(REPO_ROOT, 'tools', 'analysis', 'verify-suite.mjs'),
        ...partArguments(job, serial, runDir, passed),
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', log, log] },
    )
    child.on('close', () => {
      closeSync(log)
      let rows = []
      try {
        rows = JSON.parse(readFileSync(join(rowsDir, `${job.dirName}.json`), 'utf8')).rows ?? []
      } catch {
        // No result file: the process ended before it could judge anything.
      }
      const judged = rows.filter((row) => !row.superseded).at(-1)
      done(
        judged ?? {
          workoutId: job.workoutId,
          vocab: job.vocab,
          verdict: 'ERROR',
          reason: 'the suite process ended without a result',
          elapsedMs: 0,
        },
      )
    })
  })
}

/**
 * Several emulators at once.
 *
 * The base AVD is brought up to date in an ordinary instance — build
 * installed, permissions granted, QA mode on — and stopped. Then N
 * READ-ONLY instances of it start: each boots from that state, shares the
 * base image, and throws its changes away when it stops, so they cannot
 * disturb one another or the base. Each takes the next drive from one queue.
 */
async function runSeveral(opts) {
  const suite = parseSuiteArgs(
    suiteArguments(opts.suiteArgs, 'x').filter((arg) => !arg.startsWith('--device=')),
  )
  const jobs = planJobs(readdirSync(MANIFESTS_DIR), suite)
  const runDir = resolve(REPO_ROOT, suite.out ?? join(SUITES_DIR, String(Date.now())))
  const ports = instancePorts(opts.port, Math.min(opts.jobs, jobs.length))
  const serials = ports.map(serialFor)
  const upNow = devicesFromAdb(run('adb', ['devices']).stdout)
  const inTheWay = serials.filter((serial) => upNow.includes(serial))
  if (inTheWay.length > 0) {
    throw new Stop(
      `${inTheWay.join(', ')} already running. Several at once need the AVD to themselves — stop ${inTheWay.length === 1 ? 'it' : 'them'}, or use --jobs=1`,
    )
  }

  const base = serials[0]
  say(`bringing ${opts.avd} up to date`)
  await ensureEmulator(opts, base)
  try {
    ensureInstalled(base)
    grantBluetooth(base)
    await enableQaMode(base)
  } finally {
    stopEmulator(base)
  }
  await waitUntilGone(base, 120_000)

  say(`starting ${ports.length} read-only instances of ${opts.avd}: ${serials.join(', ')}`)
  for (const port of ports) startEmulator(opts, port, true)
  try {
    for (const serial of serials) {
      run('adb', ['-s', serial, 'wait-for-device'], { timeout: opts.bootTimeoutMs })
      await waitForBoot(serial, opts.bootTimeoutMs)
      const refusal = deviceRefusal({
        serial,
        isEmulator: true,
        avdName: avdNameFrom(adb(serial, 'emu', 'avd', 'name').stdout),
        expectedAvd: opts.avd,
      })
      if (refusal) throw new Stop(refusal)
    }

    const queue = [...jobs]
    const rows = new Map()
    let finished = 0
    const worker = async (serial) => {
      for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
        const row = await drivePart(job, serial, runDir, opts.suiteArgs)
        rows.set(job.dirName, row)
        finished += 1
        say(
          `${finished}/${jobs.length} ${job.workoutId} (${job.vocab}) ${row.verdict}${row.reason ? ` — ${row.reason}` : ''} · ${serial}`,
        )
      }
    }
    await Promise.all(serials.map(worker))

    // Not reported until it has had the machine to itself.
    for (const job of jobs.filter((each) => needsRedrive(rows.get(each.dirName)))) {
      const busy = rows.get(job.dirName)
      say(
        `${job.workoutId} (${job.vocab}) was ${busy.verdict} with ${ports.length} running — driving it again alone`,
      )
      const alone = await drivePart(job, base, join(runDir, 'alone'), opts.suiteArgs)
      rows.set(job.dirName, afterRedrive(busy, alone))
      say(`  alone: ${alone.verdict}${alone.reason ? ` — ${alone.reason}` : ''}`)
    }

    const ordered = jobs.map((job) => rows.get(job.dirName))
    const exitCode = aggregateVerdicts(ordered.map((row) => row.verdict))
    const summary = renderSummaryMd(ordered, {
      suiteId: String(Date.now()),
      deviceId: `${serials.length} read-only instances of ${opts.avd}`,
      deviceIsEmulator: true,
      launch: suite.launch,
      vocab: suite.vocab,
      sim: suite.sim,
      firstRoundOnly: suite.firstRoundOnly,
      timingGate: suite.timingGate,
      exitCode,
    })
    const redriven = ordered.filter((row) => row.redrivenAlone)
    const note =
      redriven.length === 0
        ? ''
        : `\n### Driven again alone\n\n${redriven.map((row) => `- **${row.workoutId} (${row.vocab})** — ${row.redrivenAlone.verdictWhenBusy} with ${serials.length} emulators running${row.redrivenAlone.reasonWhenBusy ? ` (${row.redrivenAlone.reasonWhenBusy})` : ''}; **${row.verdict}** alone, which is what is reported.`).join('\n')}\n`
    writeFileSync(join(runDir, 'summary.md'), summary + note)
    writeFileSync(
      join(runDir, 'summary.json'),
      JSON.stringify({ serials, exitCode, rows: ordered }, null, 2) + '\n',
    )
    console.log(`\n${summary}${note}`)
    say(`done · exit ${exitCode} · ${join(runDir, 'summary.md')}`)
    return exitCode
  } finally {
    if (!opts.keepRunning) for (const serial of serials) stopEmulator(serial)
  }
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
    if (opts.jobs > 1)
      say(
        `would run it as ${opts.jobs} read-only instances on ports ${instancePorts(opts.port, opts.jobs).join(', ')}, one drive each at a time`,
      )
    return 0
  }
  // Build first: it needs no device, and a refusal here costs nothing.
  ensureBuild(opts)
  if (opts.jobs > 1) return runSeveral(opts)
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
