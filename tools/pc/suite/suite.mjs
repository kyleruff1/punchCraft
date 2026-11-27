// The verify suite, on the PC.
//
//   npm run pc:suite                               every workout, round 1
//   npm run pc:suite -- --only quick-one-two       some of them
//   npm run pc:suite -- --vocab techniques         (or `both`)
//   npm run pc:suite -- --full                     whole workouts, not round 1
//   npm run pc:suite -- --no-build                 serve the build already in dist/
//   npm run pc:suite -- --no-sound                 do not listen to what the page plays
//   npm run pc:suite -- --record                   keep what it played, as sound.webm
//
// Each workout is driven in a headless browser from the same QA link the
// tablet suite uses, its log is saved in the tablet's layout, and the
// tablet's own correlator (`tools/analysis/verify-first-round.mjs`) judges
// it against the same manifest. What is said, in what order and when is
// decided by code both devices share; a failure here is a failure there.
//
// What it does not judge is the tablet's audio path. The tablet's timing
// analyzer refuses a capture from here, on purpose.
//
// Exit: 0 all passed, 2 a warning, 1 a failure or a drive that broke,
// 4 a manifest that no longer matches the build — the tablet suite's codes.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  aggregateVerdicts,
  budgetMs,
  compactStats,
  planJobs,
  verdictFromVerifyExit,
  worstVerdict,
} from '../../analysis/verify-suite.mjs'
import { findBrowser } from '../app/cdp.mjs'
import { buildWebApp, isBuilt, OUT_DIR, REPO_ROOT, serveWebApp } from '../app/webApp.mjs'
import { TRUNCATION_MS } from '../../analysis/observed-summary.mjs'
import { loadTimingConstants } from '../../analysis/timing-constants.mjs'
import { fieldsOf, recordsOf } from './capture.mjs'
import { driveState, driveWorkout } from './drive.mjs'
import { renderSoundReport, soundReport } from './sound.mjs'
import { spread } from './stats.mjs'

const MANIFESTS_DIR = path.join(REPO_ROOT, 'tools', 'analysis', 'manifests')
const RUNS_DIR = path.join(REPO_ROOT, 'tools', 'pc', 'suite', 'runs')
/** The simulated punches every stored tablet suite used — so the two compare. */
export const DEFAULT_SIM = 'captured-jam'

/**
 * @param {string[]} argv
 * @returns {{ only: string[], vocab: string, full: boolean, build: boolean, out: string | null, sim: string, sound: boolean, record: boolean }}
 */
export function parseArgs(argv) {
  const args = {
    only: [],
    vocab: 'numbers',
    full: false,
    build: true,
    out: null,
    sim: DEFAULT_SIM,
    sound: true,
    record: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s)
    const value = () => {
      const v = inline ?? argv[(i += 1)]
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`)
      return v
    }
    if (flag === '--only') args.only.push(...value().split(',').filter(Boolean))
    else if (flag === '--vocab') args.vocab = value()
    else if (flag === '--sim') args.sim = value()
    else if (flag === '--out') args.out = value()
    else if (flag === '--full') args.full = true
    else if (flag === '--no-build') args.build = false
    else if (flag === '--no-sound') args.sound = false
    else if (flag === '--record') args.record = true
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (!['numbers', 'techniques', 'both'].includes(args.vocab)) {
    throw new Error(`--vocab is numbers, techniques or both, not ${args.vocab}`)
  }
  if (args.record && !args.sound) throw new Error('--record needs the sound tap: drop --no-sound')
  return args
}

/**
 * How late this machine ran the workout's own loop — reported, never judged.
 *
 * `dispatch` is how long after its scheduled time each clip was sent to play;
 * `ringToken` is the same for the runner's ring-token record, which is the
 * 50 ms loop's telemetry and not the painted ring (that follows the clock on
 * animation frames). They describe this PC under this load, and nothing else.
 */
export function lateness(records) {
  return {
    dispatch: spread(
      recordsOf(records, 'workout.clickScript.dispatch').map((r) => fieldsOf(r).lateMs),
    ),
    ringToken: spread(
      recordsOf(records, 'workout.cue.tokenDue').map(
        (r) => fieldsOf(r).workElapsedMs - fieldsOf(r).scheduledMs,
      ),
    ),
  }
}

/**
 * A drive's verdict, from what it left behind and what the correlator said.
 * Pure. `reasons` says everything that pulled the verdict down, worst first.
 *
 * @param {object} input
 * @param {import('./drive.mjs').Drive} input.drive
 * @param {number | null} input.verifyExit the correlator's exit code, or null if it was not run
 * @param {string} input.hostSha the checkout's commit
 * @param {string} input.nonce the nonce the link carried
 * @returns {{ verdict: string, reasons: string[] }}
 */
export function driveVerdict({ drive, verifyExit, hostSha, nonce }) {
  const state = driveState(drive.records)
  const broke = (reason) => ({ verdict: 'ERROR', reasons: [reason] })
  if (drive.reason !== null && drive.reason !== 'over-budget') return broke(drive.reason)
  if (!state.workEntered) return broke('the round never began')
  if (drive.staged?.nonce !== nonce)
    return broke('the page ran a different link than the one opened')

  let verdict = verdictFromVerifyExit(verifyExit)
  const reasons = []
  const worsen = (to, reason) => {
    verdict = worstVerdict(verdict, to)
    reasons.push(reason)
  }
  if (drive.reason === 'over-budget') worsen('ERROR', 'the round did not end within its budget')
  if (drive.problems.length > 0) {
    worsen('FAIL', `${drive.problems.length} error(s) on the page: ${drive.problems[0]}`)
  }
  if (verdict === 'STALE')
    reasons.push('the build compiled a different timeline than the manifest describes')
  if (drive.staged?.gitSha !== hostSha) {
    worsen('WARN', `the build is ${drive.staged?.gitSha}, the checkout is ${hostSha}`)
  }
  if (drive.visibility !== 'visible') {
    worsen(
      'WARN',
      `the page was ${drive.visibility}, not visible — a browser slows the timers of a page it is not showing`,
    )
  }
  return { verdict, reasons }
}

const ms = (v) => (v === null || v === undefined ? '—' : String(v))
const clock = (elapsedMs) =>
  `${Math.floor(elapsedMs / 60_000)}:${String(Math.round(elapsedMs / 1000) % 60).padStart(2, '0')}`

/**
 * `summary.md`. The tablet suite's table is not reused: its columns are the
 * tablet's instruments, and a PC row under those headings would be read as
 * a tablet measurement.
 *
 * @param {any[]} rows
 * @param {{ suiteId: string, hostSha: string, browser: string, args: ReturnType<typeof parseArgs> }} meta
 */
export function renderSummary(rows, meta) {
  const count = (verdict) => rows.filter((r) => r.verdict === verdict).length
  const tally = ['PASS', 'WARN', 'FAIL', 'STALE', 'ERROR']
    .filter((v) => count(v) > 0)
    .map((v) => `${count(v)} ${v}`)
    .join(' · ')
  const L = [
    `# PC suite — ${meta.suiteId}`,
    '',
    `checkout ${meta.hostSha} · ${meta.args.full ? 'whole workouts' : 'round 1'} · simulated punches: ${meta.args.sim} · ${path.basename(meta.browser)}`,
    '',
    `**${tally || 'nothing ran'}**`,
    '',
    '| workout | vocab | verdict | correlator | page errors | clips heard | silent / cut short | last sound → ring due, least / median ms | dispatch late, median / p95 ms | ring token late, median / p95 ms | took |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    const d = r.lateness?.dispatch
    const t = r.lateness?.ringToken
    const s = r.sound
    const heard = s ? `${s.clips.heard} of ${s.clips.played}` : '—'
    const lost = s ? `${s.clips.silent.length} / ${s.clips.cutShort.length}` : '—'
    const gap = s ? `${ms(s.calls.breath.minMs)} / ${ms(s.calls.breath.medianMs)}` : '—'
    L.push(
      `| ${r.workoutId} | ${r.vocab} | ${r.verdict} | ${r.stats ?? '—'} | ${r.pageProblems.length} | ${heard} | ${lost} | ${gap} | ${ms(d?.medianMs)} / ${ms(d?.p95Ms)} | ${ms(t?.medianMs)} / ${ms(t?.p95Ms)} | ${clock(r.elapsedMs)} |`,
    )
  }
  const explained = rows.filter((r) => r.reasons.length > 0)
  if (explained.length > 0) {
    L.push('', '## Why')
    for (const r of explained)
      for (const reason of r.reasons) L.push(`- **${r.workoutId}** (${r.vocab}): ${reason}`)
  }
  L.push(
    '',
    '## How to read this',
    '',
    '- **correlator** is the tablet’s own first-round verifier, run on this capture against the same manifest. What is said, in what order and when is code both devices share.',
    '- **The sound columns are measured**, not modelled: each call and lead-in is listened to in the page, and “last sound → ring due” is the gap between a call’s last sound and the scheduled time of the ring it leads. In this version they are reported, not judged. Each drive’s folder has the full `sound-report.md`.',
    '- **The lateness columns are this PC’s**, under whatever else it was doing. They are reported, not judged, and no tablet constant is ever set from them. The ring token is the runner’s 50 ms loop, not the painted ring.',
    '- **The tablet’s audio path is not judged here.** Its timing analyzer refuses a capture from a browser.',
    '',
  )
  return L.join('\n')
}

let limits = null
/**
 * The two thresholds the sound report is read against. Both are the tablet
 * gate's own, read from where it keeps them — the floor from the app's
 * source, the truncation allowance from the tablet's analyzer.
 */
function soundLimits() {
  limits ??= { floorMs: loadTimingConstants().breath.MIN_BREATH_MS, truncationMs: TRUNCATION_MS }
  return limits
}

/** Run the tablet's correlator on a saved capture. */
function correlate(dir, manifestPath) {
  const verify = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'tools', 'analysis', 'verify-first-round.mjs'),
      '--manifest',
      manifestPath,
      '--session',
      dir,
    ],
    { encoding: 'utf8', cwd: REPO_ROOT },
  )
  writeFileSync(
    path.join(dir, 'verify-stdout.txt'),
    (verify.stdout ?? '') + (verify.stderr ?? ''),
    'utf8',
  )
  const reportPath = path.join(dir, 'verify-report.json')
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
  return {
    verifyExit: verify.status,
    stats: report ? compactStats(report) : null,
    health: report?.health ?? null,
  }
}

/** Drive one workout, judge it, and return its row for the summary. */
async function runJob({ job, args, executable, baseUrl, suiteId, suiteDir, hostSha }) {
  const dir = path.join(suiteDir, job.dirName)
  const manifestPath = path.join(MANIFESTS_DIR, job.manifestFile)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const budget = budgetMs(manifest, { firstRoundOnly: !args.full })
  const nonce = `pc-${suiteId}-${job.dirName}`
  console.info(`── ${job.workoutId} (${job.vocab}) · budget ${Math.round(budget / 1000)} s`)
  const drive = await driveWorkout({
    executable,
    baseUrl,
    job,
    sim: args.sim,
    firstRoundOnly: !args.full,
    budgetMs: budget,
    nonce,
    dir,
    sound: args.sound,
    record: args.record,
  })
  // Reported in this version, not judged.
  const sound = drive.sound ? soundReport(drive.records, drive.sound, soundLimits()) : null
  if (sound) {
    writeFileSync(
      path.join(dir, 'sound-report.json'),
      JSON.stringify(sound, null, 2) + '\n',
      'utf8',
    )
    writeFileSync(
      path.join(dir, 'sound-report.md'),
      renderSoundReport(sound, `${job.workoutId} (${job.vocab})`),
      'utf8',
    )
  }
  // A drive that never reached a round has nothing for the correlator to read.
  const reached = driveState(drive.records).workEntered
  const judged = reached
    ? correlate(dir, manifestPath)
    : { verifyExit: null, stats: null, health: null }
  const { verdict, reasons } = driveVerdict({
    drive,
    verifyExit: judged.verifyExit,
    hostSha,
    nonce,
  })
  const row = {
    workoutId: job.workoutId,
    vocab: job.vocab,
    platform: 'web',
    sessionDir: path.relative(REPO_ROOT, dir),
    manifest: job.manifestFile,
    timelineHash: manifest.identity?.timelineHash ?? null,
    url: drive.url,
    budgetMs: budget,
    verdict,
    reasons,
    ...judged,
    build: {
      dev: drive.staged?.dev ?? null,
      gitSha: drive.staged?.gitSha ?? null,
      hostSha,
      platform: drive.staged?.platform ?? null,
      qaEnabled: drive.staged?.qaEnabled ?? null,
      sim: drive.staged?.sim ?? null,
    },
    ended: drive.ended,
    visibility: drive.visibility,
    pageProblems: drive.problems,
    lateness: lateness(drive.records),
    sound,
    recorded: drive.recorded,
    elapsedMs: drive.elapsedMs,
  }
  writeFileSync(path.join(dir, 'drive.json'), JSON.stringify(row, null, 2) + '\n', 'utf8')
  const late = row.lateness.dispatch
  console.info(
    `   ${verdict}${row.stats ? ` · ${row.stats}` : ''} · dispatch late ${ms(late.medianMs)} / ${ms(late.p95Ms)} ms · ${clock(row.elapsedMs)}`,
  )
  if (sound) {
    const gap = sound.calls.breath
    console.info(
      `   sound: ${sound.clips.heard} of ${sound.clips.played} clips heard · last sound → ring ${ms(gap.minMs)} least, ${ms(gap.medianMs)} median · ${sound.clips.silent.length} silent · ${sound.clips.cutShort.length} cut short`,
    )
  }
  for (const reason of reasons) console.info(`   ! ${reason}`)
  return row
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(
      `${err instanceof Error ? err.message : err}\nSee the top of tools/pc/suite/suite.mjs for the arguments.`,
    )
    return 3
  }
  const executable = findBrowser()
  if (!executable) {
    console.error('No Chrome or Edge found. Set PC_SMOKE_BROWSER to a Chromium browser.')
    return 3
  }
  const jobs = planJobs(readdirSync(MANIFESTS_DIR), { only: args.only, vocab: args.vocab })
  if (args.build) {
    console.info('Building the app for the browser...')
    await buildWebApp({ quiet: true })
  } else if (!isBuilt()) {
    console.error(`No build in ${OUT_DIR}. Run without --no-build first.`)
    return 3
  }
  const hostSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  const suiteId = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const suiteDir = args.out ? path.resolve(args.out) : path.join(RUNS_DIR, suiteId)
  mkdirSync(suiteDir, { recursive: true })

  // Port 0: a free one, so this never collides with a `pc:app` left running.
  const served = await serveWebApp({ port: 0 })
  console.info(
    `PC suite ${suiteId}: ${jobs.length} drive(s), ${args.full ? 'whole workouts' : 'round 1'} → ${suiteDir}`,
  )
  const rows = []
  try {
    for (const job of jobs) {
      rows.push(
        await runJob({ job, args, executable, baseUrl: served.url, suiteId, suiteDir, hostSha }),
      )
    }
  } finally {
    await served.close()
  }
  const exitCode = aggregateVerdicts(rows.map((r) => r.verdict))
  const meta = { suiteId, hostSha, browser: executable, args }
  writeFileSync(
    path.join(suiteDir, 'summary.json'),
    JSON.stringify({ ...meta, platform: 'web', exitCode, rows }, null, 2) + '\n',
    'utf8',
  )
  const md = renderSummary(rows, meta)
  writeFileSync(path.join(suiteDir, 'summary.md'), md, 'utf8')
  console.info(`\n${md}`)
  return exitCode
}

// Run only as a script: jest imports this file for its pure parts.
// (A `.then`, not a top-level await: jest loads this file as CommonJS.)
if (process.argv[1]?.endsWith('suite.mjs')) {
  void main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err)
      process.exit(1)
    },
  )
}
