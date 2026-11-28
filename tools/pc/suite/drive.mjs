// One workout, driven in a browser from the QA link to the end of the round.
//
// The PC's counterpart of `driveOne` in `tools/analysis/verify-suite.mjs`,
// without the device: no adb, no logcat process, no keyguard, no volume. The
// link is the same one, built by the same function, so the app is asked for
// exactly what the tablet suite asks it for.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { runQuery } from '../../analysis/verify-suite.mjs'
import { launchBrowser, openPage, sleep } from '../app/cdp.mjs'
import { codeOf, fieldsOf, logcatText, otherConsoleText } from './capture.mjs'
import { faultSource } from './faults.mjs'
import { SOUND_BINDING, soundTapSource } from './soundTap.mjs'

/** Longer than the web database's save delay: the next step reloads the page. */
export const QA_SWITCH_SETTLE_MS = 2_000
/** From opening the link to the runner starting. On this PC it takes about two seconds. */
export const START_TIMEOUT_MS = 60_000
/** Kept listening after the last bell, for the records that trail it. */
export const TAIL_MS = 3_000

const byId = (id) => `document.querySelector('[data-testid="${id}"]')`

/**
 * How far a drive has got, from the records so far. Pure.
 *
 * @param {import('../app/recordTap.mjs').PageRecord[]} records
 * @param {{ firstRoundOnly?: boolean }} [options]
 */
export function driveState(records, { firstRoundOnly = true } = {}) {
  const state = {
    /** The QA run record's fields, once the link has been staged. */
    staged: /** @type {Record<string, any> | null} */ (null),
    /** The link was refused: QA mode is off, or it did not parse. */
    refused: /** @type {string | null} */ (null),
    started: false,
    workEntered: false,
    /** What ended it: `work-entered` (round 2 opening), `completed` or `cancelled`. */
    ended: /** @type {string | null} */ (null),
  }
  for (const record of records) {
    const code = codeOf(record)
    if (code === 'workout.qa.run') state.staged = fieldsOf(record)
    else if (code === 'workout.qa.run.blocked') state.refused = 'qa-flag-off'
    else if (code === 'workout.qa.run.invalid') state.refused = 'invalid-link'
    else if (code === 'workout.runner.start') state.started = true
    else if (code === 'workout.round.boundary') {
      const { transition, roundIndex } = fieldsOf(record)
      if (transition === 'work-entered') state.workEntered = true
      // A round-1 run is round 1 and the rest after it: it ends at the bell
      // that opens round 2, so the rest line and the countdown into that
      // bell are in it. A one-round workout simply completes.
      const secondBell = firstRoundOnly && transition === 'work-entered' && roundIndex >= 1
      const over = transition === 'completed' || transition === 'cancelled'
      if (state.ended === null && (secondBell || over)) state.ended = transition
    }
  }
  return state
}

/**
 * @typedef {object} Drive what one drive left behind
 * @property {import('../app/recordTap.mjs').PageRecord[]} records every console call from the link onwards
 * @property {string[]} problems what the page complained about (the smoke test's rule)
 * @property {string | null} ended the boundary that ended it, or null
 * @property {string | null} reason why it stopped short, or null
 * @property {Record<string, any> | null} staged the QA run record's fields
 * @property {any[] | null} sound the sound tap's events from the link onwards; null when it was not listening
 * @property {boolean} recorded whether `sound.webm` was written
 * @property {string} visibility `document.visibilityState` while it ran
 * @property {string} url the page address that was opened
 * @property {number} elapsedMs
 */

/**
 * Drive one workout in a browser of its own and save the capture into `dir`.
 *
 * A fresh browser on a fresh profile every time: no saved database, no
 * setting left by the last drive, and the one-tab lock never in the way.
 *
 * @param {object} options
 * @param {string} options.executable the browser, from `findBrowser`
 * @param {string} options.baseUrl where the built app is served, ending in `/`
 * @param {{ workoutId: string, vocab: string }} options.job
 * @param {string} options.sim the simulated punch script, as the tablet suite names it
 * @param {boolean} options.firstRoundOnly
 * @param {number} options.budgetMs the most a drive may take from the link to its last bell
 * @param {string} options.nonce
 * @param {string} options.dir
 * @param {boolean} [options.sound] listen to what the page plays (`soundTap.mjs`)
 * @param {boolean} [options.record] and keep it, as `sound.webm`
 * @param {string | null} [options.fault] break the app on purpose, to prove the gate (`faults.mjs`)
 * @returns {Promise<Drive>}
 */
export async function driveWorkout({
  executable,
  baseUrl,
  job,
  sim,
  firstRoundOnly,
  budgetMs,
  nonce,
  dir,
  sound = false,
  record = false,
  fault = null,
}) {
  mkdirSync(dir, { recursive: true })
  const startedAt = performance.now()
  const url = `${baseUrl}qa/run?${runQuery({ workout: job.workoutId, vocab: job.vocab, sim, nonce })}`
  const browser = await launchBrowser(executable)
  let page
  /** @type {Drive} */
  const drive = {
    records: [],
    problems: [],
    ended: null,
    reason: null,
    staged: null,
    sound: null,
    recorded: false,
    visibility: 'unknown',
    url,
    elapsedMs: 0,
  }
  let from = 0
  /** @type {any[]} */
  const heard = []
  let heardFrom = 0
  try {
    page = await openPage(browser.wsUrl, {
      wholeRecords: true,
      ...(sound
        ? {
            // The fault first: the tap must sit outside it, to report each
            // play at the moment the app asked for it.
            beforeLoad: [...(fault ? [faultSource(fault)] : []), soundTapSource({ record })],
            receivers: { [SOUND_BINDING]: (payload) => heard.push(JSON.parse(payload)) },
          }
        : {}),
    })
    // QA mode is a setting, switched on in the app as a person would. A link
    // cannot switch it on — that is the route's own rule.
    await page.goto(`${baseUrl}settings`)
    await page.waitFor('the Settings screen', `${byId('qa-mode-switch')} !== null`, 30_000)
    await page.evaluate(`(() => {
      const el = ${byId('qa-mode-switch')}
      ;(el.matches('input') ? el : (el.querySelector('input') ?? el)).click()
    })()`)
    await sleep(QA_SWITCH_SETTLE_MS)

    from = page.records.length
    // The Settings page was a page of its own, with a clock of its own.
    heardFrom = heard.length
    const linkAt = performance.now()
    await page.goto(url)
    for (;;) {
      const state = driveState(page.records.slice(from), { firstRoundOnly })
      const waited = performance.now() - linkAt
      if (state.refused) drive.reason = state.refused
      else if (!state.started && waited > START_TIMEOUT_MS) drive.reason = 'never-started'
      else if (state.ended === null && waited > budgetMs) drive.reason = 'over-budget'
      if (state.ended !== null || drive.reason !== null) {
        drive.ended = state.ended
        break
      }
      await sleep(250)
    }
    drive.visibility = String(
      await page.evaluate('document.visibilityState').catch(() => 'unknown'),
    )
    if (drive.ended !== null) await sleep(TAIL_MS)
    if (record) {
      await page.evaluate('globalThis.__pcStopRecording?.()').catch(() => undefined)
      await sleep(500)
    }
  } catch (err) {
    drive.reason = `driver: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    drive.records = page ? page.records.slice(from) : []
    drive.problems = page ? [...page.problems] : []
    drive.staged = driveState(drive.records, { firstRoundOnly }).staged
    drive.elapsedMs = Math.round(performance.now() - startedAt)
    page?.close()
    await browser.close()
  }
  writeFileSync(path.join(dir, 'logcat.txt'), logcatText(drive.records), 'utf8')
  writeFileSync(path.join(dir, 'records.json'), JSON.stringify(drive.records), 'utf8')
  const other = otherConsoleText(drive.records)
  if (other !== '') writeFileSync(path.join(dir, 'console-other.txt'), other + '\n', 'utf8')
  if (sound) {
    const events = heard.slice(heardFrom)
    // The recording arrives in pieces among the events; together they are one file.
    const pieces = events.filter((event) => event.type === 'recording')
    drive.sound = events.filter((event) => event.type !== 'recording')
    writeFileSync(path.join(dir, 'sound-events.json'), JSON.stringify(drive.sound), 'utf8')
    if (pieces.length > 0) {
      writeFileSync(
        path.join(dir, 'sound.webm'),
        Buffer.concat(pieces.map((piece) => Buffer.from(piece.data, 'base64'))),
      )
      drive.recorded = true
    }
  }
  return drive
}
