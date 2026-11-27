// Does the PC say what the tablet said?
//
//   npm run pc:parity                                  the newest PC run against the tablet reference
//   npm run pc:parity -- --run <a PC run's folder>
//   npm run pc:parity -- --build-reference <tablet suite folder> [more…]
//
// The tablet reference (`tablet-reference/`, committed) is what a tablet
// suite's captures said was scheduled in round 1 of each workout, with the
// build and timeline it came from. A PC run is compared to it:
//
// - What is said, in what order, at what scheduled time, leading which ring
//   must be identical. A difference is a real cross-platform bug: FAIL.
// - How late each device ran is set side by side and never judged.
// - A workout whose timeline has changed since the tablet capture is
//   skipped, with a note: it needs a new tablet run, not a red mark.
//
// Exit: 0 nothing differs, 1 something does, 3 usage.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { REPO_ROOT } from '../app/webApp.mjs'
import { dispatchKey, scheduleOf } from './schedule.mjs'

export const REFERENCE_DIR = path.join(REPO_ROOT, 'tools', 'pc', 'suite', 'tablet-reference')
const RUNS_DIR = path.join(REPO_ROOT, 'tools', 'pc', 'suite', 'runs')

/** `quick-one-two.json`, or `quick-one-two.techniques.json` — the manifests' own naming. */
export const referenceName = (workoutId, vocab) =>
  vocab === 'techniques' ? `${workoutId}.techniques.json` : `${workoutId}.json`

/**
 * How many dispatches a tablet capture may be short of the PC's and still be
 * read as the same schedule with lines lost.
 *
 * The tablet's log drops lines under load — one ring-token line was missing
 * from the very capture this tool was first tried on, though the ring fired.
 * So a PC run that holds everything the tablet's capture holds, in order,
 * plus one or two dispatches more, is the tablet's log losing them. More than
 * that is not a log problem, and fails.
 */
export const LOST_LINES_ALLOWED = 2

/**
 * One workout's reference, from a tablet drive: what its capture holds of
 * round 1, and where it came from.
 *
 * @param {object} input
 * @param {string} input.logcatText the tablet capture
 * @param {any} input.drive the tablet suite's row for it (`drive.json`)
 * @param {{ suite: string, capturedOn: string }} input.source
 */
export function referenceFrom({ logcatText, drive, source }) {
  const schedule = scheduleOf(logcatText)
  if (!schedule) return null
  return {
    workoutId: drive.workoutId,
    vocab: drive.vocab,
    timelineHash: drive.timelineHash,
    source: {
      ...source,
      device: 'tablet',
      build: drive.build?.gitSha ?? null,
      simulatedPunches: drive.build?.sim ?? null,
      verdict: drive.verdict,
      correlator: drive.stats ?? null,
    },
    round1: { dispatches: schedule.dispatches, tokensDue: schedule.tokensDue },
    // The tablet's own figures, for the side-by-side. Round 1.
    timing: { dispatchLateMs: schedule.dispatchLateMs, ringTokenLateMs: schedule.ringTokenLateMs },
  }
}

/**
 * The clips that are not the same recording on the two sides: a slot whose
 * clip has a different length, or different words.
 *
 * A clip that has been re-recorded since the tablet capture is sent at a
 * different time — it has to end the same distance before its ring — and
 * shifts the lead-in before it. That is the corpus moving on, not the
 * devices disagreeing, and the stored timeline hash does not see it: the
 * hash covers the rings, not the recordings. So it is looked for directly.
 *
 * @param {import('./schedule.mjs').Dispatch[]} pc
 * @param {import('./schedule.mjs').Dispatch[]} tablet
 * @returns {string[]} one line per changed clip
 */
export function changedClips(pc, tablet) {
  const table = (dispatches) => {
    const clips = new Map()
    for (const d of dispatches)
      if (!clips.has(d.slot) || clips.get(d.slot).text === null) clips.set(d.slot, d)
    return clips
  }
  const then = table(tablet)
  const changed = []
  for (const [slot, now] of table(pc)) {
    const was = then.get(slot)
    if (!was) continue
    const words = was.text !== null && now.text !== null && was.text !== now.text
    if (was.durationMs !== now.durationMs || words) {
      const say = (d) => `${d.text === null ? '' : `“${d.text}”, `}${d.durationMs} ms`
      changed.push(`${slot} was ${say(was)} and is ${say(now)}`)
    }
  }
  return changed
}

/** A dispatch whose play record the log lost has no text; compare it without. */
const keyFor = (wanted) =>
  wanted.text === null ? (d) => dispatchKey({ ...d, text: null }) : dispatchKey

/**
 * Two round-1 schedules.
 *
 * `differences` is empty when the tablet's dispatches are all in the PC's,
 * in the same order — the same words, times and rings. `pcOnly` is then what
 * the PC holds besides: nothing, when the two are identical.
 *
 * @param {import('./schedule.mjs').Dispatch[]} pc
 * @param {import('./schedule.mjs').Dispatch[]} tablet
 */
export function compareSchedules(pc, tablet) {
  const matched = new Set()
  const differences = []
  let at = 0
  for (const [index, wanted] of tablet.entries()) {
    const key = keyFor(wanted)
    let found = -1
    for (let i = at; i < pc.length; i += 1) {
      if (key(pc[i]) === key(wanted)) {
        found = i
        break
      }
    }
    if (found < 0) {
      // Say what the PC had in that place, if anything.
      differences.push({
        index,
        tablet: dispatchKey(wanted),
        pc: pc[index] ? dispatchKey(pc[index]) : null,
      })
    } else {
      matched.add(found)
      at = found + 1
    }
  }
  return {
    same: tablet.length - differences.length,
    differences,
    pcOnly: pc.filter((_, i) => !matched.has(i)).map(dispatchKey),
  }
}

/**
 * One workout of a PC run against its tablet reference.
 *
 * @param {object} input
 * @param {any} input.row the PC suite's row
 * @param {ReturnType<typeof scheduleOf>} input.schedule round 1 of the PC capture
 * @param {any | null} input.reference the tablet reference, or null if there is none
 */
export function parityOf({ row, schedule, reference }) {
  const base = {
    workoutId: row.workoutId,
    vocab: row.vocab,
    pc: null,
    tablet: null,
    differences: [],
    notes: [],
  }
  const skipped = (why) => ({ ...base, status: 'SKIPPED', notes: [why] })
  if (!reference) return skipped('no tablet capture of this workout to compare with')
  if (!schedule) return skipped('the PC drive never reached a round')
  if (reference.timelineHash !== row.timelineHash) {
    return skipped(
      `the timeline has changed since the tablet capture (${reference.timelineHash} then, ${row.timelineHash} now) — it needs a new tablet run`,
    )
  }
  const tablet = reference.round1.dispatches
  const rerecorded = changedClips(schedule.dispatches, tablet)
  if (rerecorded.length > 0) {
    return skipped(
      `${rerecorded.length} clip(s) have been re-recorded since the tablet capture, which moves when they are sent — it needs a new tablet run: ${rerecorded.slice(0, 3).join('; ')}`,
    )
  }
  const { same, differences, pcOnly } = compareSchedules(schedule.dispatches, tablet)
  const notes = []
  const untexted = tablet.filter((d) => d.text === null).length
  if (untexted > 0)
    notes.push(
      `${untexted} of the tablet’s dispatches have no play record in its capture (its log drops lines); they were compared without their words`,
    )
  let status = differences.length === 0 ? 'SAME' : 'DIFFERS'
  if (differences.length === 0 && pcOnly.length > 0) {
    if (pcOnly.length <= LOST_LINES_ALLOWED) {
      notes.push(
        `the PC holds ${pcOnly.length} dispatch(es) the tablet’s capture does not — read as lines its log lost: ${pcOnly.join(' · ')}`,
      )
    } else {
      status = 'DIFFERS'
      notes.push(
        `the PC dispatched ${pcOnly.length} clips the tablet’s capture does not hold — too many to be lost log lines`,
      )
    }
  }
  return {
    ...base,
    status,
    notes,
    same,
    of: tablet.length,
    differences: differences.slice(0, 5),
    differenceCount: differences.length,
    pcOnly: pcOnly.slice(0, 5),
    pcOnlyCount: pcOnly.length,
    pc: {
      dispatchLateMs: schedule.dispatchLateMs,
      ringTokenLateMs: schedule.ringTokenLateMs,
      gapBeforeRingMs: row.sound?.calls.breath ?? null,
      firstSoundMs: row.sound?.start.afterDispatch ?? null,
    },
    tablet: { ...reference.timing, source: reference.source },
  }
}

const cell = (v) => (v === null || v === undefined ? '—' : String(v))
const pair = (s) => (s ? `${cell(s.medianMs)} / ${cell(s.p95Ms)}` : '—')

/** `parity.md`. */
export function renderParity(rows, meta) {
  const count = (status) => rows.filter((r) => r.status === status).length
  const L = [
    `# PC against the tablet — ${meta.run}`,
    '',
    `**${count('SAME')} the same · ${count('DIFFERS')} differ · ${count('SKIPPED')} skipped**`,
    '',
    'Round 1 of each workout. “Said the same” is every dispatch: which clip, its words, when it was due, how long it is, and when the ring it leads is due.',
    '',
    '| workout | vocab | said the same | dispatch late, PC | dispatch late, tablet | ring token late, PC | ring token late, tablet | tablet capture |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    const said =
      r.status === 'SKIPPED'
        ? 'skipped'
        : r.status === 'SAME'
          ? `yes — ${r.same} of ${r.of}${r.pcOnlyCount > 0 ? `, and ${r.pcOnlyCount} more the tablet’s log lost` : ''}`
          : `**NO — ${r.differenceCount} differ${r.pcOnlyCount > 0 ? `, ${r.pcOnlyCount} only on the PC` : ''}**`
    const from = r.tablet ? `${r.tablet.source.capturedOn}, build ${r.tablet.source.build}` : '—'
    L.push(
      `| ${r.workoutId} | ${r.vocab} | ${said} | ${pair(r.pc?.dispatchLateMs)} | ${pair(r.tablet?.dispatchLateMs)} | ${pair(r.pc?.ringTokenLateMs)} | ${pair(r.tablet?.ringTokenLateMs)} | ${from} |`,
    )
  }
  const differing = rows.filter((r) => r.status === 'DIFFERS')
  if (differing.length > 0) {
    L.push('', '## What differs')
    for (const r of differing) {
      L.push(`- **${r.workoutId}** (${r.vocab}):`)
      for (const d of r.differences)
        L.push(
          `  - #${d.index + 1} PC: ${d.pc ?? '(nothing)'} · tablet: ${d.tablet ?? '(nothing)'}`,
        )
    }
  }
  const noted = rows.filter((r) => r.notes.length > 0)
  if (noted.length > 0) {
    L.push('', '## Notes')
    for (const r of noted)
      for (const note of r.notes) L.push(`- **${r.workoutId}** (${r.vocab}): ${note}`)
  }
  L.push(
    '',
    '## How to read this',
    '',
    '- **Said the same** must be yes. Which clip plays when, and which ring it leads, is decided by code both devices run; a difference is a bug on one of them.',
    '- **The lateness columns are median / 95th percentile, in ms, and are not compared.** Each is one device under its own load. Nothing on the tablet is tuned from the PC’s.',
    '- **Skipped** is not a failure: there is no tablet capture of that workout, or its timeline or one of its clips has changed since the capture was taken. The note says which. A skipped workout is not compared at all, so it is no evidence either way until the tablet runs again.',
    '',
  )
  return L.join('\n')
}

/** Write a reference file for every judged drive in a tablet suite folder. */
function buildReference(suiteDirs) {
  mkdirSync(REFERENCE_DIR, { recursive: true })
  let written = 0
  for (const suiteDir of suiteDirs) {
    for (const entry of readdirSync(suiteDir, { withFileTypes: true })) {
      const dir = path.join(suiteDir, entry.name)
      const logPath = path.join(dir, 'logcat.txt')
      const drivePath = path.join(dir, 'drive.json')
      if (!entry.isDirectory() || !existsSync(logPath) || !existsSync(drivePath)) continue
      const drive = JSON.parse(readFileSync(drivePath, 'utf8'))
      const reference = referenceFrom({
        logcatText: readFileSync(logPath, 'utf8'),
        drive,
        // The capture's own lines carry no year; the file's date does.
        source: {
          suite: path.basename(suiteDir),
          capturedOn: statSync(logPath).mtime.toISOString().slice(0, 10),
        },
      })
      if (!reference) {
        console.info(`  - ${entry.name}: never reached a round — no reference`)
        continue
      }
      const file = path.join(REFERENCE_DIR, referenceName(drive.workoutId, drive.vocab))
      // One dispatch to a line: a changed schedule shows as changed lines.
      const json = JSON.stringify(reference, null, 1).replace(
        /\{\s+"kind": ([^\n]+)\s+"slot": ([^\n]+)\s+"dispatchAtMs": ([^\n]+)\s+"durationMs": ([^\n]+)\s+"firstNodeMs": ([^\n]+)\s+"text": ([^\n]+)\s+\}/g,
        '{ "kind": $1 "slot": $2 "dispatchAtMs": $3 "durationMs": $4 "firstNodeMs": $5 "text": $6 }',
      )
      writeFileSync(file, json + '\n', 'utf8')
      written += 1
      console.info(
        `  - ${entry.name}: ${reference.round1.dispatches.length} dispatches in round 1 · ${reference.timelineHash}`,
      )
    }
  }
  console.info(`${written} reference file(s) in ${REFERENCE_DIR}`)
  return written > 0 ? 0 : 3
}

/** The newest folder in `runs/` that holds a finished suite. */
function newestRun() {
  if (!existsSync(RUNS_DIR)) return null
  const finished = readdirSync(RUNS_DIR)
    .map((name) => path.join(RUNS_DIR, name))
    .filter((dir) => existsSync(path.join(dir, 'summary.json')))
    .sort(
      (a, b) =>
        statSync(path.join(a, 'summary.json')).mtimeMs -
        statSync(path.join(b, 'summary.json')).mtimeMs,
    )
  return finished.at(-1) ?? null
}

function compareRun(runDir) {
  const summaryPath = path.join(runDir, 'summary.json')
  if (!existsSync(summaryPath)) {
    console.error(`No summary.json in ${runDir} — is it a PC suite run?`)
    return 3
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
  const rows = summary.rows.map((row) => {
    const logPath = path.join(REPO_ROOT, row.sessionDir, 'logcat.txt')
    const refPath = path.join(REFERENCE_DIR, referenceName(row.workoutId, row.vocab))
    return parityOf({
      row,
      schedule: existsSync(logPath) ? scheduleOf(readFileSync(logPath, 'utf8')) : null,
      reference: existsSync(refPath) ? JSON.parse(readFileSync(refPath, 'utf8')) : null,
    })
  })
  const md = renderParity(rows, { run: path.basename(runDir) })
  writeFileSync(
    path.join(runDir, 'parity.json'),
    JSON.stringify({ run: summary.suiteId, rows }, null, 2) + '\n',
    'utf8',
  )
  writeFileSync(path.join(runDir, 'parity.md'), md, 'utf8')
  console.info(md)
  return rows.some((r) => r.status === 'DIFFERS') ? 1 : 0
}

function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === '--build-reference') {
    const dirs = argv.slice(1)
    if (dirs.length === 0 || dirs.some((d) => !existsSync(d))) {
      console.error('Usage: npm run pc:parity -- --build-reference <tablet suite folder> [more…]')
      return 3
    }
    return buildReference(dirs)
  }
  const runAt = argv.indexOf('--run')
  const runDir = runAt >= 0 ? argv[runAt + 1] : newestRun()
  if (!runDir || (runAt < 0 && argv.length > 0)) {
    console.error(
      'Usage: npm run pc:parity [-- --run <a PC run folder>]   (no finished run was found)',
    )
    return 3
  }
  return compareRun(path.resolve(runDir))
}

// Run only as a script: jest imports this file for its pure parts.
if (process.argv[1]?.endsWith('parity.mjs')) process.exit(main())
