// The verify suite, on the PC.
//
//   npm run pc:suite                               every workout, round 1
//   npm run pc:suite -- --only quick-one-two       some of them
//   npm run pc:suite -- --vocab techniques         (or `both`)
//   npm run pc:suite -- --full                     whole workouts, not round 1
//   npm run pc:suite -- --no-build                 serve the build already in dist/
//   npm run pc:suite -- --no-sound                 do not listen to what the page plays
//   npm run pc:suite -- --record                   keep what it played, as sound.webm
//   npm run pc:suite -- --sound-gate warn          a sound finding warns instead of failing (or `off`)
//   npm run pc:suite -- --fault mute               break the app on purpose (see faults.mjs)
//   npm run pc:suite -- --jobs 1                   how many browsers at once (default: by the machine)
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
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {
  aggregateVerdicts,
  budgetMs,
  compactStats,
  planJobs,
  roundsArgument,
  roundsJudgedText,
  verdictFromVerifyExit,
  worstVerdict,
} from '../../analysis/verify-suite.mjs'
import { findBrowser } from '../app/cdp.mjs'
import { buildWebApp, isBuilt, OUT_DIR, REPO_ROOT, serveWebApp } from '../app/webApp.mjs'
import { TRUNCATION_MS } from '../../analysis/observed-summary.mjs'
import { FLOOR_BREACH_SOFT_RATIO } from '../../analysis/observed-timing.mjs'
import { loadTimingConstants } from '../../analysis/timing-constants.mjs'
import { fieldsOf, recordsOf } from './capture.mjs'
import { driveState, driveWorkout } from './drive.mjs'
import { FAULTS } from './faults.mjs'
import { ringReport, ringVerdict } from './rings.mjs'
import { renderSoundReport, soundReport, soundVerdict } from './sound.mjs'
import { spread } from './stats.mjs'

const MANIFESTS_DIR = path.join(REPO_ROOT, 'tools', 'analysis', 'manifests')
const RUNS_DIR = path.join(REPO_ROOT, 'tools', 'pc', 'suite', 'runs')
/**
 * How many drives to run at once on a machine with this many processors:
 * half of them, and no more than six.
 *
 * Each drive is a browser of its own playing a workout in real time — a
 * 50 ms loop, an animation, a little audio — so it sits well under one
 * processor. What matters is that none has to wait for one: a drive that
 * waits dispatches late, and its timing figures are about the queue.
 *
 * Measured here (16 processors, 2026-11-26, One-Two round 1): the delay from
 * a clip's scheduled send to its first sound was 102 / 116 ms alone,
 * 105 / 112 with three neighbours and 109 / 115 with five (median / 95th
 * percentile) — no difference. All 22 workouts, six at a time, took 18½
 * minutes against an hour and three quarters in series, with no call under
 * the floor in 1 379. More than six, and fewer than half the processors
 * idle, have not been measured.
 *
 * @param {number} [processors]
 */
export function defaultJobs(processors = os.availableParallelism()) {
  return Math.max(1, Math.min(6, Math.floor(processors / 2)))
}

/** The simulated punches every stored tablet suite used — so the two compare. */
export const DEFAULT_SIM = 'captured-jam'

/**
 * @param {string[]} argv
 * @returns {{ only: string[], vocab: string, full: boolean, build: boolean, out: string | null, sim: string, sound: boolean, record: boolean, soundGate: string, fault: string | null, jobs: number | null }}
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
    soundGate: 'fail',
    fault: null,
    /** How many drives at once; null until `main` asks the machine. */
    jobs: /** @type {number | null} */ (null),
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
    else if (flag === '--sound-gate') args.soundGate = value()
    else if (flag === '--fault') args.fault = value()
    else if (flag === '--jobs') args.jobs = Number(value())
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (!['numbers', 'techniques', 'both'].includes(args.vocab)) {
    throw new Error(`--vocab is numbers, techniques or both, not ${args.vocab}`)
  }
  if (args.record && !args.sound) throw new Error('--record needs the sound tap: drop --no-sound')
  if (!['fail', 'warn', 'off'].includes(args.soundGate)) {
    throw new Error(`--sound-gate is fail, warn or off, not ${args.soundGate}`)
  }
  if (args.fault !== null && !FAULTS.includes(args.fault)) {
    throw new Error(`--fault is one of ${FAULTS.join(', ')}, not ${args.fault}`)
  }
  if (args.fault !== null && !args.sound)
    throw new Error('--fault needs the sound tap: drop --no-sound')
  if (args.jobs !== null && !(Number.isInteger(args.jobs) && args.jobs >= 1)) {
    throw new Error('--jobs is a whole number, 1 or more')
  }
  return args
}

/**
 * What the app itself said went wrong, across the whole capture.
 *
 * `couldNotPlay` is every clip it logged failing to play or failing to find:
 * a fault in any round. `skipped` and `deferred` are calls it chose not to
 * make — the coach lane was busy — which is the app working as designed, and
 * is counted.
 *
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 */
export function admissions(records) {
  const named = (code, key) =>
    recordsOf(records, code).map(
      (r) => `${code.replace('workout.', '')}: ${fieldsOf(r)[key] ?? fieldsOf(r).text ?? '?'}`,
    )
  return {
    couldNotPlay: [
      ...named('workout.voice.playFailed', 'asset'),
      ...named('workout.voice.clipMissing', 'asset'),
      ...named('workout.slotDispatcher.assetMissing', 'assetId'),
    ],
    skipped: recordsOf(records, 'workout.clickScript.skipped').length,
    deferred: recordsOf(records, 'workout.slotDispatcher.deferred').length,
  }
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
 * @param {{ verdict: string, hard: string[], soft: string[] } | null} [input.sound] the sound gate's word, if it listened
 * @param {string} [input.soundGate] `fail` (a hard sound finding fails the drive), `warn` or `off`
 * @param {{ hard: string[], soft: string[] } | null} [input.rings] the ring check's word
 * @returns {{ verdict: string, reasons: string[] }}
 */
export function driveVerdict({
  drive,
  verifyExit,
  hostSha,
  nonce,
  sound = null,
  soundGate = 'fail',
  rings = null,
}) {
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
  // What the app itself logged it could not do, in any round. The correlator
  // reads these for round 1 only; nothing else reads them at all.
  const { couldNotPlay } = admissions(drive.records)
  if (couldNotPlay.length > 0) {
    worsen(
      'FAIL',
      `the app logged ${couldNotPlay.length} clip(s) it could not play — first: ${couldNotPlay[0]}`,
    )
  }
  if (drive.problems.length > 0) {
    worsen('FAIL', `${drive.problems.length} error(s) on the page: ${drive.problems[0]}`)
  }
  if (verdict === 'STALE')
    reasons.push('the build compiled a different timeline than the manifest describes')
  if (sound && soundGate !== 'off') {
    // Only ever makes a drive worse: clean sound cannot rescue a drive the
    // correlator failed.
    for (const finding of sound.hard) worsen(soundGate === 'fail' ? 'FAIL' : 'WARN', finding)
    for (const finding of sound.soft) worsen('WARN', finding)
  }
  if (rings) {
    for (const finding of rings.hard) worsen('FAIL', finding)
    for (const finding of rings.soft) worsen('WARN', finding)
  }
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
 * The app's playback observer against the audio elements, over every drive,
 * as one paragraph — or null when no drive had anything to compare.
 *
 * @param {any[]} rows
 * @returns {string | null}
 */
export function observerLine(rows) {
  const reports = rows.map((r) => r.sound?.observer).filter((o) => o && o.compared > 0)
  if (reports.length === 0) return null
  const sum = (pick) => reports.reduce((n, o) => n + pick(o), 0)
  // The furthest apart the two were, either way round, in any drive.
  const apart = (key) => {
    const ends = reports.flatMap((o) => [o[key].minMs, o[key].maxMs]).filter(Number.isFinite)
    return ends.length === 0 ? '—' : String(Math.max(...ends.map(Math.abs)))
  }
  return `The app timed ${sum((o) => o.records)} plays by its players’ status events, and ${sum((o) => o.compared)} of them could be held against the audio element that played them. The two differ by at most ${apart('startMs')} ms on when a clip began and ${apart('endMs')} ms on when it ended. ${sum((o) => o.unseen.length)} sounded that the observer never saw start; ${sum((o) => o.unheard.length)} it saw start made no sound. Reported, not judged — each drive’s \`sound-report.md\` has its own figures.`
}

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
    `checkout ${meta.hostSha} · ${meta.args.full ? 'whole workouts' : 'round 1 and its rest'} · ${meta.args.jobs ?? 1} at a time · simulated punches: ${meta.args.sim} · sound ${meta.args.sound ? `gate: ${meta.args.soundGate}` : 'not listened to'} · ${path.basename(meta.browser)}`,
    '',
    ...(meta.args.fault
      ? [
          `**Fault injected on purpose: \`${meta.args.fault}\`. This run exists to show the sound gate failing; it says nothing about the app.**`,
          '',
        ]
      : []),
    `**${tally || 'nothing ran'}**`,
    '',
    '| workout | vocab | verdict | correlator | page errors | clips heard | silent / cut short | last sound → ring due, least / median ms | rings lit | ring painted late, median / most ms | dispatch late, median / p95 ms | ring token late, median / p95 ms | took |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    const d = r.lateness?.dispatch
    const t = r.lateness?.ringToken
    const s = r.sound
    const heard = s ? `${s.clips.heard} of ${s.clips.played}` : '—'
    const lost = s ? `${s.clips.silent.length} / ${s.clips.cutShort.length}` : '—'
    const gap = s ? `${ms(s.calls.breath.minMs)} / ${ms(s.calls.breath.medianMs)}` : '—'
    const g = r.rings
    const lit = g ? `${g.lit} of ${g.rings}` : '—'
    const painted = g ? `${ms(g.paintedLate.medianMs)} / ${ms(g.paintedLate.maxMs)}` : '—'
    L.push(
      `| ${r.workoutId} | ${r.vocab} | ${r.verdict} | ${r.stats ?? '—'}${r.roundsJudged ? ` · ${r.roundsJudged}` : ''} | ${r.pageProblems.length} | ${heard} | ${lost} | ${gap} | ${lit} | ${painted} | ${ms(d?.medianMs)} / ${ms(d?.p95Ms)} | ${ms(t?.medianMs)} / ${ms(t?.p95Ms)} | ${clock(r.elapsedMs)} |`,
    )
  }
  const explained = rows.filter((r) => r.reasons.length > 0)
  if (explained.length > 0) {
    L.push('', '## Why')
    for (const r of explained)
      for (const reason of r.reasons) L.push(`- **${r.workoutId}** (${r.vocab}): ${reason}`)
  }
  const observer = observerLine(rows)
  if (observer) L.push('', '## The app’s own observer', '', observer)
  L.push(
    '',
    '## How to read this',
    '',
    '- **correlator** is the tablet’s own verifier, run on this capture against the same manifest. What is said, in what order and when is code both devices share. “3 of 3 rounds” is how many of the workout’s rounds it judged: a round is judged only when the capture holds it whole.',
    '- **The sound columns are measured**, not modelled: each call and lead-in is listened to in the page, and “last sound → ring due” is the gap between a call’s last sound and the scheduled time of the ring it leads. A clip that makes no sound, one cut short, or a call still sounding when its ring is due fails the drive. Each drive’s folder has the full `sound-report.md`.',
    '- **The lateness columns are this PC’s**, under whatever else it was doing. They are reported, not judged, and no tablet constant is ever set from them. The ring token is the runner’s 50 ms loop, not the painted ring.',
    '- **How far a drive was meant to run is part of the verdict.** The default drive is round 1 and the rest after it, and the correlator is told to expect round 1; `--full` is the whole workout, and it is told to expect every round. A round that was meant to be driven and is not whole in the capture fails the drive. The manifest gives each round its lead-ins by name and its calls by count — not each call by name.',
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

/**
 * Whether a drive ran to where it was meant to: no reason to have stopped
 * short, and ended on the bell that opens round 2 or on the last one. A
 * cancelled drive ended, but not there.
 */
export function endedAsMeant(drive) {
  return drive.reason === null && (drive.ended === 'work-entered' || drive.ended === 'completed')
}

/**
 * Run the tablet's correlator on a saved capture, telling it how far the
 * drive was meant to run so that a round it should hold and does not fails
 * the run (`roundsArgument`).
 */
function correlate(dir, manifestPath, { wholeWorkout, endedCleanly }) {
  const verify = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'tools', 'analysis', 'verify-first-round.mjs'),
      '--manifest',
      manifestPath,
      '--session',
      dir,
      ...roundsArgument({ wholeWorkout, endedCleanly }),
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
    roundsJudged: roundsJudgedText(report) || null,
    health: report?.health ?? null,
  }
}

/** Drive one workout, judge it, and return its row for the summary. */
async function runJob({ job, args, executable, baseUrl, suiteId, suiteDir, hostSha }) {
  const dir = path.join(suiteDir, job.dirName)
  const manifestPath = path.join(MANIFESTS_DIR, job.manifestFile)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // A round-1 run goes on through the rest that follows, to the next bell.
  const firstRest = args.full ? 0 : (manifest.scheduleMs?.[0]?.restMs ?? 0)
  const budget = budgetMs(manifest, { firstRoundOnly: !args.full }) + firstRest
  const nonce = `pc-${suiteId}-${job.dirName}`
  // Several drives run at once, so a drive's lines are kept and printed
  // together when it is done; only its start is announced as it happens.
  const lines = [`── ${job.workoutId} (${job.vocab})`]
  console.info(`▶ ${job.workoutId} (${job.vocab}) · budget ${Math.round(budget / 1000)} s`)
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
    fault: args.fault,
  })
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
  const rings = ringReport(drive.records)
  writeFileSync(path.join(dir, 'rings-report.json'), JSON.stringify(rings, null, 2) + '\n', 'utf8')
  // A drive that never reached a round has nothing for the correlator to read.
  const reached = driveState(drive.records).workEntered
  const judged = reached
    ? correlate(dir, manifestPath, {
        wholeWorkout: args.full === true,
        endedCleanly: endedAsMeant(drive),
      })
    : { verifyExit: null, stats: null, roundsJudged: null, health: null }
  const { verdict, reasons } = driveVerdict({
    drive,
    verifyExit: judged.verifyExit,
    hostSha,
    nonce,
    sound: sound ? soundVerdict(sound, { floorRatio: FLOOR_BREACH_SOFT_RATIO }) : null,
    soundGate: args.soundGate,
    rings: reached ? ringVerdict(rings) : null,
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
    admissions: admissions(drive.records),
    sound,
    rings,
    recorded: drive.recorded,
    elapsedMs: drive.elapsedMs,
  }
  writeFileSync(path.join(dir, 'drive.json'), JSON.stringify(row, null, 2) + '\n', 'utf8')
  const late = row.lateness.dispatch
  lines.push(
    `   ${verdict}${row.stats ? ` · ${row.stats}` : ''} · dispatch late ${ms(late.medianMs)} / ${ms(late.p95Ms)} ms · ${clock(row.elapsedMs)}`,
  )
  if (sound) {
    const gap = sound.calls.breath
    lines.push(
      `   sound: ${sound.clips.heard} of ${sound.clips.played} clips heard · last sound → ring ${ms(gap.minMs)} least, ${ms(gap.medianMs)} median · ${sound.clips.silent.length} silent · ${sound.clips.cutShort.length} cut short`,
    )
  }
  lines.push(
    `   rings: ${rings.lit} of ${rings.rings} lit · painted ${ms(rings.paintedLate.medianMs)} ms after their time (most ${ms(rings.paintedLate.maxMs)})`,
  )
  for (const reason of reasons) lines.push(`   ! ${reason}`)
  console.info(lines.join('\n'))
  return row
}

/**
 * Run `task` over `items`, at most `limit` at a time. The results come back
 * in the items' order, whatever order they finished in.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} task
 * @returns {Promise<R[]>}
 */
export async function pooled(items, limit, task) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
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
  args.jobs ??= defaultJobs()
  console.info(
    `PC suite ${suiteId}: ${jobs.length} drive(s), ${args.full ? 'whole workouts' : 'round 1 and its rest'}, ${args.jobs} at a time → ${suiteDir}`,
  )
  let rows
  try {
    rows = await pooled(jobs, args.jobs, (job) =>
      runJob({ job, args, executable, baseUrl: served.url, suiteId, suiteDir, hostSha }),
    )
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
