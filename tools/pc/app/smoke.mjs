#!/usr/bin/env node
// Runs the PC version end to end in a real browser, with nobody watching.
//
//   npm run pc:smoke                 build, then run
//   npm run pc:smoke -- --no-build   run against the last build
//   PC_SMOKE_BROWSER=/path/to/chrome npm run pc:smoke
//
// What it proves, on a profile that has never seen the app:
//   1. the app boots — the WebAssembly database engine loads and migrates;
//   2. a setting changed in the app survives a reload (QA mode, which the
//      run itself needs: only the Settings switch can turn it on);
//   3. a workout starts, the coach's calls go out, simulated punches count;
//   4. stopping and saving writes the session;
//   5. after another reload the saved database — read straight out of the
//      browser's storage and opened here, outside the app — holds it, and
//      History and the session's summary show what the live counter counted;
//   6. a second tab does not start — two would save over each other;
//   7. nothing on the page threw, rejected unhandled, logged an error or
//      failed to load, at any point.
//
// What it cannot prove: that the coach is AUDIBLE and on time. It sees calls
// dispatched, not heard. Local only — it needs Chrome or Edge on the machine.
import { createRequire } from 'node:module'
import process from 'node:process'

import { findBrowser, launchBrowser, openPage, sleep } from './cdp.mjs'
import { buildWebApp, isBuilt, OUT_DIR, REPO_ROOT, serveWebApp } from './webApp.mjs'

const WORKOUT = 'three-round-fundamentals'
const byId = (id) => `document.querySelector('[data-testid="${id}"]')`
/**
 * The count out of the live screen's punch tile, whose text is the label and
 * then "12 / 237": the number before the slash.
 */
export function punchesIn(text) {
  const match = /(\d[\d,]*)\s*\//.exec(String(text ?? ''))
  return match ? Number(match[1].replace(/,/g, '')) : 0
}

// Read with this script's own few lines, not the app's: IndexedDB database
// `punchcraft`, store `files`, key `punchcraft.db` (`idbByteStore.web.ts`).
const READ_DATABASE = `(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('punchcraft')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const stored = await new Promise((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').get('punchcraft.db')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  if (!stored) throw new Error('nothing is saved under punchcraft.db')
  const bytes = stored instanceof Uint8Array ? stored : new Uint8Array(stored)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
})()`

/** Open the bytes the browser saved, with the same engine, outside the app. */
async function openSaved(base64) {
  const require = createRequire(`${REPO_ROOT}/package.json`)
  const SQL = await require('sql.js')()
  const db = new SQL.Database(Buffer.from(base64, 'base64'))
  const scalar = (sql) => db.exec(sql)[0]?.values[0]?.[0]
  return { scalar }
}

async function run(page, base, openAnother) {
  const step = (text) => console.info(`  - ${text}`)

  await page.goto(`${base}settings`)
  await page.waitFor('the Settings screen', `${byId('qa-mode-switch')} !== null`, 30_000)
  step('booted: the database engine loaded and the app rendered')

  // The switch is a checkbox under the test id; a real click, as a person's.
  await page.evaluate(`(() => {
    const el = ${byId('qa-mode-switch')}
    ;(el.matches('input') ? el : (el.querySelector('input') ?? el)).click()
  })()`)
  // Longer than the save delay: the next step reloads the page, and the
  // setting has to be on disk by then.
  await sleep(2_000)

  const from = page.consoleLines.length
  const fromRecord = page.records.length
  await page.goto(`${base}qa/run?workout=${WORKOUT}&sim=alternating-1-2&autostart=1&nonce=smoke`)
  await page.waitFor('the live screen', `location.pathname === '/punchcraft/live'`, 30_000)
  if (page.logged('workout.qa.run.blocked', from)) {
    throw new Error('QA mode did not survive the reload: the setting was not saved')
  }
  step('a setting changed in the app survived a reload')

  // The verifiers read fields a console preview cuts off after the fifth.
  // `platform` is the QA record's twentieth, and it is what stops the
  // tablet's timing analyzer judging a capture from here.
  const staged = page.records.slice(fromRecord).find((r) => r.args[0] === '[INFO] workout.qa.run')
  const platform = staged?.args[2]?.platform
  if (platform !== 'web') {
    throw new Error(`the QA run record should name the platform "web"; it says ${platform}`)
  }
  step('the log arrives whole: the QA run record names its platform')

  await page.waitFor(
    'the workout to start itself',
    `${page.logged('workout.qa.autostart', from)} || ${byId('control-pause')} !== null`,
    30_000,
  )
  // Past the intro and into round 1: calls dispatched, punches counted.
  let punchesSeen = 0
  for (let waited = 0; ; waited += 500) {
    const punches = punchesIn(await page.evaluate(`${byId('metric-punches')}?.innerText`))
    punchesSeen = punches
    const calls = page.consoleLines.slice(from).filter((l) => l.includes('clickScript.dispatch'))
    if (punches > 0 && calls.length >= 2) {
      step(`round 1 ran: ${calls.length} calls dispatched, ${punches} simulated punches counted`)
      break
    }
    if (waited > 120_000) {
      throw new Error(`round 1 never got going: ${calls.length} calls, ${punches} punches`)
    }
    await sleep(500)
  }

  await page.evaluate(`${byId('control-stop')}.click()`)
  await page.waitFor('the keep-or-discard question', `${byId('confirm-save')} !== null`)
  await page.evaluate(`${byId('confirm-save')}.click()`)
  for (let waited = 0; !page.logged('workout.session.persisted', from); waited += 250) {
    if (waited > 15_000) throw new Error('the session was never written')
    await sleep(250)
  }
  step('stopped and saved')
  await sleep(2_000)

  await page.goto(base)
  await page.waitFor('the workout list after a reload', `${byId('designed-workouts')} !== null`)
  const saved = await openSaved(await page.evaluate(READ_DATABASE))
  const sessions = saved.scalar(`SELECT COUNT(*) FROM sessions WHERE mode = 'punchcraft'`)
  const cues = saved.scalar('SELECT COUNT(*) FROM cue_results')
  const runs = saved.scalar('SELECT COUNT(*) FROM workout_runs')
  if (sessions !== 1 || !(cues > 0) || runs !== 1) {
    throw new Error(`the saved database is wrong: ${sessions} sessions, ${cues} cues, ${runs} runs`)
  }
  step(`after a reload the saved database holds it: 1 session, ${cues} cue results`)

  // What the live counter counted is kept with the session (migration 009),
  // and History shows that — not the handful of punches the cue results hold.
  const counted = JSON.parse(saved.scalar('SELECT live_counts_json FROM sessions') ?? 'null')
  if (!counted || !(counted.total >= punchesSeen) || counted.source !== 'simulated') {
    throw new Error(`the live counts were not saved as counted: ${JSON.stringify(counted)}`)
  }
  await page.evaluate(`${byId('open-history')}.click()`)
  const row = `document.querySelector('[data-testid^="history-row-"]')`
  await page.waitFor('the session in History', `${row} !== null`)
  const rowText = String(await page.evaluate(`${row}.innerText`))
  for (const expected of [`${counted.total} punches`, 'Stopped early', 'Simulated']) {
    if (!rowText.includes(expected)) {
      throw new Error(`the History row does not say "${expected}": ${JSON.stringify(rowText)}`)
    }
  }
  await page.evaluate(`${row}.click()`)
  await page.waitFor('the session summary', `${byId('summary-screen')} !== null`)
  const summaryText = String(await page.evaluate(`${byId('summary-screen')}.innerText`))
  for (const expected of [String(counted.total), 'Stopped in round 1 of', 'Simulated punches']) {
    if (!summaryText.includes(expected)) {
      throw new Error(`the summary does not say "${expected}": ${JSON.stringify(summaryText)}`)
    }
  }
  step(`History lists it, and its summary shows the ${counted.total} punches the counter counted`)

  // A second tab, while this one is still open.
  const second = await openAnother()
  await second.goto(base)
  const notice = await second.waitFor(
    'the second tab to say it will not start',
    `${byId('storage-failed')}?.innerText`,
  )
  second.close()
  if (second.problems.length > 0) throw new Error(`the second tab: ${second.problems.join('; ')}`)
  step(`a second tab did not start: "${String(notice).slice(0, 44)}…"`)
}

async function main() {
  const executable = findBrowser()
  if (!executable) {
    console.error('No Chrome or Edge found. Set PC_SMOKE_BROWSER to a Chromium browser.')
    return 2
  }
  if (!process.argv.includes('--no-build')) {
    console.info('Building the app for the browser...')
    await buildWebApp({ quiet: true })
  } else if (!isBuilt()) {
    console.error(`No build in ${OUT_DIR}. Run without --no-build first.`)
    return 2
  }

  // Port 0: a free one, so this never collides with a `pc:app` left running.
  const served = await serveWebApp({ port: 0 })
  const browser = await launchBrowser(executable)
  let page
  let failure = null
  try {
    page = await openPage(browser.wsUrl, { wholeRecords: true })
    console.info(`PC smoke test: ${served.url}`)
    await run(page, served.url, () => openPage(browser.wsUrl))
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  } finally {
    page?.close()
    await browser.close()
    await served.close()
  }

  const problems = page?.problems ?? []
  if (failure) console.error(`\nFAILED: ${failure}`)
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) on the page:`)
    for (const problem of problems) console.error(`  ! ${problem}`)
  }
  if (failure || problems.length > 0) {
    const tail = (page?.consoleLines ?? []).slice(-15)
    if (tail.length > 0) console.error(`\nThe app's last log lines:\n  ${tail.join('\n  ')}`)
    return 1
  }
  const withheld = page?.withheld ?? []
  if (withheld.length > 0) {
    console.info(
      `\n(${withheld.length} haptic calls withheld by the browser: a script is not a touch.)`,
    )
  }
  console.info('\nPASSED: no errors on the page.')
  return 0
}

// Run only as a script: jest imports this file for `punchesIn`.
// (A `.then`, not a top-level await: jest loads this file as CommonJS.)
if (process.argv[1]?.endsWith('smoke.mjs')) void main().then((code) => process.exit(code))
