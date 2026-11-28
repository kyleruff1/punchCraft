// Does the PC say what the device said?
//
//   npm run pc:parity                                  the newest PC run against the reference
//   npm run pc:parity -- --run <a PC run's folder>
//   npm run pc:parity -- --build-reference <device suite folder> [more…]
//
// The reference (`device-reference/`, committed) is what a native build's
// suite captures said was scheduled in each round of each workout, with the
// device, build and timeline it came from. A PC run is compared to it:
//
// - What is said, in what order, at what scheduled time, leading which ring
//   must be identical, in every round both hold whole. A difference is a real
//   cross-platform bug: FAIL.
// - How late each device ran is set side by side, under its device's name,
//   and never judged.
// - A workout whose timeline has changed since the capture is skipped, with a
//   note: it needs a new device run, not a red mark.
//
// A reference says which device wrote it: the tablet, or an Android emulator.
// What is said and when it is due is the same code on both, so either will
// do for that. The lateness beside it will not: an emulator on this PC is a
// PC. So a reference built from an emulator keeps the tablet's own figures
// from the reference it replaces, under the date they were taken.
//
// Exit: 0 nothing differs, 1 something does, 3 usage.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { capturePlatform, EMULATOR_PLATFORM } from '../../analysis/logcat.mjs'
import { REPO_ROOT } from '../app/webApp.mjs'
import { dispatchKey, scheduleOf } from './schedule.mjs'

export const REFERENCE_DIR = path.join(REPO_ROOT, 'tools', 'pc', 'suite', 'device-reference')
const RUNS_DIR = path.join(REPO_ROOT, 'tools', 'pc', 'suite', 'runs')

/** `quick-one-two.json`, or `quick-one-two.techniques.json` — the manifests' own naming. */
export const referenceName = (workoutId, vocab) =>
  vocab === 'techniques' ? `${workoutId}.techniques.json` : `${workoutId}.json`

/**
 * How many dispatches a device capture may be short of the PC's and still be
 * read as the same schedule with lines lost.
 *
 * A device's log drops lines under load — one ring-token line was missing
 * from the very capture this tool was first tried on, though the ring fired.
 * So a PC run that holds everything the device's capture holds, in order,
 * plus one or two dispatches more, is the device's log losing them. More than
 * that is not a log problem, and fails. The allowance is for the whole
 * workout, however many rounds are compared.
 */
export const LOST_LINES_ALLOWED = 2

/**
 * What a reference calls the device that wrote a capture: `tablet`,
 * `emulator` — or null for a capture that cannot be a reference. A PC
 * capture cannot: the reference is what the PC is compared WITH.
 *
 * The suite's own row is asked first. The suite asks the DEVICE whether it
 * is an emulator (`deviceIsEmulator`; before that field, the reason it gave
 * for not judging timing), where a capture only says so on a build new
 * enough to. A capture from an emulator running an older build reads as
 * the tablet's — it was once labelled so here, on the first real capture
 * this was tried on.
 *
 * **What this cannot see:** a run folder from a suite older than
 * 2026-11-27, driven on an emulator. Neither its row nor its capture says.
 * Never build a reference from one.
 *
 * @param {string} logcatText
 * @param {{ deviceIsEmulator?: boolean, timingRefusal?: string | null } | null} [drive] the suite row
 */
export function referenceDevice(logcatText, drive = null) {
  const platform = capturePlatform(logcatText)
  if (platform !== 'android' && platform !== EMULATOR_PLATFORM) return null
  const rowSaysEmulator =
    drive?.deviceIsEmulator === true || /\bemulator\b/.test(drive?.timingRefusal ?? '')
  return platform === EMULATOR_PLATFORM || rowSaysEmulator ? 'emulator' : 'tablet'
}

/**
 * The rounds a reference holds. One written before references held every
 * round (`round1`, no `rounds`) holds round 1 and nothing else.
 *
 * @param {any} reference
 * @returns {{ roundIndex: number, dispatches: import('./schedule.mjs').Dispatch[], tokensDue: number }[]}
 */
export const referenceRounds = (reference) =>
  Array.isArray(reference.rounds) ? reference.rounds : [{ roundIndex: 0, ...reference.round1 }]

/**
 * The tablet's own lateness figures a reference should carry forward, from
 * the reference it replaces: that one's own figures if the tablet wrote it,
 * or the ones it was itself carrying. Null when there are none.
 *
 * @param {any | null | undefined} previous
 */
export function tabletFiguresOf(previous) {
  if (!previous) return null
  if (previous.tablet) return previous.tablet
  if (previous.source?.device !== 'tablet') return null
  return {
    capturedOn: previous.source.capturedOn ?? null,
    suite: previous.source.suite ?? null,
    build: previous.source.build ?? null,
    rounds: referenceRounds(previous).length,
    timing: previous.timing,
  }
}

/**
 * One workout's reference, from a device drive: what its capture holds of
 * each round it holds whole, and where it came from. Null when the capture
 * holds no whole round, or is not a device's.
 *
 * @param {object} input
 * @param {string} input.logcatText the device capture
 * @param {any} input.drive the device suite's row for it (`drive.json`)
 * @param {{ suite: string, capturedOn: string }} input.source
 * @param {any | null} [input.previous] the reference this one replaces, for the tablet's figures
 */
export function referenceFrom({ logcatText, drive, source, previous = null }) {
  const device = referenceDevice(logcatText, drive)
  const schedule = scheduleOf(logcatText)
  if (device === null || !schedule) return null
  const rounds = schedule.rounds.filter((r) => r.whole)
  if (rounds.length === 0) return null
  const tablet = device === 'tablet' ? null : tabletFiguresOf(previous)
  return {
    formatVersion: 2,
    workoutId: drive.workoutId,
    vocab: drive.vocab,
    timelineHash: drive.timelineHash,
    source: {
      ...source,
      device,
      build: drive.build?.gitSha ?? null,
      simulatedPunches: drive.build?.sim ?? null,
      verdict: drive.verdict,
      correlator: drive.stats ?? null,
    },
    rounds: rounds.map((r) => ({
      roundIndex: r.roundIndex,
      dispatches: r.dispatches,
      tokensDue: r.tokensDue,
    })),
    // The source device's own figures, for the side-by-side: every round above.
    timing: { dispatchLateMs: schedule.dispatchLateMs, ringTokenLateMs: schedule.ringTokenLateMs },
    // The tablet's, when the source is not the tablet: carried from the
    // reference this replaces, under the date they were taken.
    ...(tablet ? { tablet } : {}),
  }
}

/**
 * The clips that are not the same recording on the two sides: a slot whose
 * clip has a different length, or different words.
 *
 * A clip that has been re-recorded since the device capture is sent at a
 * different time — it has to end the same distance before its ring — and
 * shifts the lead-in before it. That is the corpus moving on, not the
 * devices disagreeing, and the stored timeline hash does not see it: the
 * hash covers the rings, not the recordings. So it is looked for directly.
 *
 * @param {import('./schedule.mjs').Dispatch[]} pc
 * @param {import('./schedule.mjs').Dispatch[]} device
 * @returns {string[]} one line per changed clip
 */
export function changedClips(pc, device) {
  const table = (dispatches) => {
    const clips = new Map()
    for (const d of dispatches)
      if (!clips.has(d.slot) || clips.get(d.slot).text === null) clips.set(d.slot, d)
    return clips
  }
  const then = table(device)
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
 * Two schedules of one round.
 *
 * `differences` is empty when the device's dispatches are all in the PC's,
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
 * One workout of a PC run against its reference: every round both hold
 * whole.
 *
 * A PC run of round 1 is compared on round 1, whatever more the reference
 * holds; a whole-workout run on every round the reference has. Neither is a
 * failure — `rounds` says how many were compared and how many each side had.
 *
 * @param {object} input
 * @param {any} input.row the PC suite's row
 * @param {ReturnType<typeof scheduleOf>} input.schedule the PC capture
 * @param {any | null} input.reference the reference, or null if there is none
 */
export function parityOf({ row, schedule, reference }) {
  const base = {
    workoutId: row.workoutId,
    vocab: row.vocab,
    pc: null,
    reference: null,
    tablet: null,
    differences: [],
    notes: [],
  }
  const skipped = (why) => ({ ...base, status: 'SKIPPED', notes: [why] })
  if (!reference) return skipped('no device capture of this workout to compare with')
  if (!schedule) return skipped('the PC drive never reached a round')
  const device = reference.source?.device ?? 'tablet'
  if (reference.timelineHash !== row.timelineHash) {
    return skipped(
      `the timeline has changed since the ${device} capture (${reference.timelineHash} then, ${row.timelineHash} now) — it needs a new device run`,
    )
  }
  const held = referenceRounds(reference)
  const pcWhole = new Map(schedule.rounds.filter((r) => r.whole).map((r) => [r.roundIndex, r]))
  const compared = held.filter((r) => pcWhole.has(r.roundIndex))
  if (compared.length === 0) {
    return skipped('the PC drive did not complete a round the reference holds')
  }
  const pcSaid = compared.flatMap((r) => pcWhole.get(r.roundIndex).dispatches)
  const deviceSaid = compared.flatMap((r) => r.dispatches)
  const rerecorded = changedClips(pcSaid, deviceSaid)
  if (rerecorded.length > 0) {
    return skipped(
      `${rerecorded.length} clip(s) have been re-recorded since the ${device} capture, which moves when they are sent — it needs a new device run: ${rerecorded.slice(0, 3).join('; ')}`,
    )
  }
  let same = 0
  const differences = []
  const pcOnly = []
  for (const round of compared) {
    const result = compareSchedules(pcWhole.get(round.roundIndex).dispatches, round.dispatches)
    same += result.same
    differences.push(...result.differences.map((d) => ({ round: round.roundIndex + 1, ...d })))
    pcOnly.push(...result.pcOnly)
  }
  const notes = []
  const untexted = deviceSaid.filter((d) => d.text === null).length
  if (untexted > 0)
    notes.push(
      `${untexted} of the ${device}’s dispatches have no play record in its capture (its log drops lines); they were compared without their words`,
    )
  let status = differences.length === 0 ? 'SAME' : 'DIFFERS'
  if (differences.length === 0 && pcOnly.length > 0) {
    if (pcOnly.length <= LOST_LINES_ALLOWED) {
      notes.push(
        `the PC holds ${pcOnly.length} dispatch(es) the ${device}’s capture does not — read as lines its log lost: ${pcOnly.join(' · ')}`,
      )
    } else {
      status = 'DIFFERS'
      notes.push(
        `the PC dispatched ${pcOnly.length} clips the ${device}’s capture does not hold — too many to be lost log lines`,
      )
    }
  }
  return {
    ...base,
    status,
    notes,
    same,
    of: deviceSaid.length,
    rounds: { compared: compared.length, reference: held.length, pc: pcWhole.size },
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
    reference: { ...reference.timing, device, source: reference.source },
    // The tablet's own figures, when the reference is not the tablet's: the
    // ones it carries from the capture it replaced. When the tablet wrote
    // the reference they are the reference's, and are not repeated.
    tablet: device === 'tablet' ? null : (reference.tablet ?? null),
  }
}

const cell = (v) => (v === null || v === undefined ? '—' : String(v))
const pair = (s) => (s ? `${cell(s.medianMs)} / ${cell(s.p95Ms)}` : '—')
/** A lateness figure under the name of the device it is from. */
const named = (s, name) => (s ? `${pair(s)} (${name})` : '—')

/** `parity.md`. */
export function renderParity(rows, meta) {
  const count = (status) => rows.filter((r) => r.status === status).length
  const L = [
    `# What the PC said against the device reference — ${meta.run}`,
    '',
    `**${count('SAME')} the same · ${count('DIFFERS')} differ · ${count('SKIPPED')} skipped**`,
    '',
    'Every round that both the PC run and the reference hold whole. “Said the same” is every dispatch: which clip, its words, when it was due, how long it is, and when the ring it leads is due.',
    '',
    '| workout | vocab | said the same | rounds compared | dispatch late, PC | dispatch late, reference | dispatch late, tablet | ring token late, PC | ring token late, reference | ring token late, tablet | reference capture |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    const said =
      r.status === 'SKIPPED'
        ? 'skipped'
        : r.status === 'SAME'
          ? `yes — ${r.same} of ${r.of}${r.pcOnlyCount > 0 ? `, and ${r.pcOnlyCount} more the device’s log lost` : ''}`
          : `**NO — ${r.differenceCount} differ${r.pcOnlyCount > 0 ? `, ${r.pcOnlyCount} only on the PC` : ''}**`
    const rounds = r.rounds ? `${r.rounds.compared} of ${r.rounds.reference}` : '—'
    const device = r.reference?.device
    const from = r.reference
      ? `${device}, ${r.reference.source.capturedOn}, build ${r.reference.source.build}`
      : '—'
    const tabletOn = r.tablet?.capturedOn ?? 'undated'
    L.push(
      `| ${r.workoutId} | ${r.vocab} | ${said} | ${rounds} | ${pair(r.pc?.dispatchLateMs)} | ${named(r.reference?.dispatchLateMs, device)} | ${named(r.tablet?.timing?.dispatchLateMs, tabletOn)} | ${pair(r.pc?.ringTokenLateMs)} | ${named(r.reference?.ringTokenLateMs, device)} | ${named(r.tablet?.timing?.ringTokenLateMs, tabletOn)} | ${from} |`,
    )
  }
  const differing = rows.filter((r) => r.status === 'DIFFERS')
  if (differing.length > 0) {
    L.push('', '## What differs')
    for (const r of differing) {
      L.push(`- **${r.workoutId}** (${r.vocab}):`)
      for (const d of r.differences)
        L.push(
          `  - round ${d.round}, #${d.index + 1} PC: ${d.pc ?? '(nothing)'} · ${r.reference.device}: ${d.tablet ?? '(nothing)'}`,
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
    '- **Said the same** must be yes. Which clip plays when, and which ring it leads, is decided by code every device runs; a difference is a bug on one of them.',
    '- **Rounds compared** is how many of the reference’s rounds the PC run held whole. A run of round 1 is compared on round 1; `pc:suite --full` on all of them.',
    '- **The lateness columns are median / 95th percentile, in ms, and are not compared.** Each is one device under its own load, and says which: the reference’s column names the device that wrote the reference. The tablet’s column is filled when that device is not the tablet, with the tablet’s own figures and the date they were taken. An emulator on this PC is a PC — its lateness is this machine’s, not the tablet’s. Nothing on the tablet is tuned from either.',
    '- **Skipped** is not a failure: there is no device capture of that workout, or its timeline or one of its clips has changed since the capture was taken. The note says which. A skipped workout is not compared at all, so it is no evidence either way until a device runs again.',
    '',
  )
  return L.join('\n')
}

/** Write a reference file for every judged drive in a device suite folder. */
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
      const logcatText = readFileSync(logPath, 'utf8')
      if (referenceDevice(logcatText, drive) === null) {
        console.info(
          `  - ${entry.name}: a ${capturePlatform(logcatText)} capture — a reference is what the PC is compared with, and has to come from a device`,
        )
        continue
      }
      const file = path.join(REFERENCE_DIR, referenceName(drive.workoutId, drive.vocab))
      const reference = referenceFrom({
        logcatText,
        drive,
        // The capture's own lines carry no year; the file's date does.
        source: {
          suite: path.basename(suiteDir),
          capturedOn: statSync(logPath).mtime.toISOString().slice(0, 10),
        },
        previous: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null,
      })
      if (!reference) {
        console.info(`  - ${entry.name}: holds no whole round — no reference`)
        continue
      }
      // One dispatch to a line: a changed schedule shows as changed lines.
      const json = JSON.stringify(reference, null, 1).replace(
        /\{\s+"kind": ([^\n]+)\s+"slot": ([^\n]+)\s+"dispatchAtMs": ([^\n]+)\s+"durationMs": ([^\n]+)\s+"firstNodeMs": ([^\n]+)\s+"text": ([^\n]+)\s+\}/g,
        '{ "kind": $1 "slot": $2 "dispatchAtMs": $3 "durationMs": $4 "firstNodeMs": $5 "text": $6 }',
      )
      writeFileSync(file, json + '\n', 'utf8')
      written += 1
      const dispatches = reference.rounds.reduce((n, r) => n + r.dispatches.length, 0)
      console.info(
        `  - ${entry.name}: ${reference.source.device} · ${reference.rounds.length} round(s), ${dispatches} dispatches · ${reference.timelineHash}${reference.tablet ? ` · the tablet’s lateness carried from ${reference.tablet.capturedOn}` : ''}`,
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
      console.error('Usage: npm run pc:parity -- --build-reference <device suite folder> [more…]')
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
