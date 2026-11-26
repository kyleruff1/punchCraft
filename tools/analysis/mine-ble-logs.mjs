#!/usr/bin/env node
/**
 * What the captured app logs say about the gloves.
 *
 * The captures under tools/analysis/{monitor,suites,sessions} were made to
 * judge the coach's audio, but the app logs its Bluetooth life into the same
 * stream: every connect, every init write with its duration, the 20 s
 * heartbeat, battery, the device-info read. With no glove on the desk that
 * is the only first-hand record there is of how the links behave — and the
 * app logs no per-punch line, so it is ALL there is.
 *
 * This reconstructs each glove link (when it came up, how long it was seen
 * alive, and whether it ended, or the capture or the app did) and tallies
 * the timings. It first ran by hand on 2026-11-25
 * (docs/handoff/08-review-and-roadmap.md §3e): 76 links, 72 seen alive past
 * 45 s, none dropped while the app kept running.
 *
 * Usage:
 *   node tools/analysis/mine-ble-logs.mjs [dir]            summary
 *   node tools/analysis/mine-ble-logs.mjs [dir] --links    one line per link
 *   node tools/analysis/mine-ble-logs.mjs [dir] --json     everything, as JSON
 * `dir` defaults to tools/analysis. Reads only.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

import { parseTimestampMs, recordTag, stitchLogRecords } from './logcat.mjs'

/** The two trackers, by address — the app logs one or the other, never both. */
export const HAND_BY_ADDRESS = {
  'D7:34:B4:27:D5:84': 'left',
  'EA:69:2D:9C:FD:53': 'right',
}

/** One 20 s heartbeat plus margin: a glove silent this long has gone. */
export const SILENCE_SLACK_MS = 25_000

const ACTIVITY = /^(ble\.(write|read)\.ok|punchstream\.write\.ok|keepalive\.(battery|deviceInfo))$/
/**
 * The first things a fresh JS runtime logs. A reload keeps the process id, so
 * these — not the pid — are what say "the app started over": everything the
 * old runtime was holding, the heartbeat included, is gone from here.
 */
const RUNTIME_START = /(^|\.)tracker-source\.start$|^keepalive\.started$/
const FIELD = /(\w+):\s*(?:'([^']*)'|(-?[\w.]+))/g
const NUMBER = /^-?\d+(\.\d+)?$/
const LEVEL = /^'\[([A-Z]+)\]/

/** Every `key: value` in a record's payload. Later keys win. */
export function fieldsOf(body) {
  const fields = {}
  FIELD.lastIndex = 0
  let m
  while ((m = FIELD.exec(body)) !== null) {
    const value = m[2] !== undefined ? m[2] : m[3]
    fields[m[1]] = NUMBER.test(value) ? Number(value) : value
  }
  return fields
}

/**
 * A capture's app records, in file order, each with an absolute-enough time.
 * A `-v time` line has no year; 2026 is assumed, and only differences inside
 * one file are ever used.
 */
export function appRecords(text) {
  const out = []
  for (const r of stitchLogRecords(text)) {
    const code = recordTag(r.body)
    if (!code) continue
    const [month, day] = r.dateStr.split('-').map(Number)
    const tMs = r.epochMs ?? Date.UTC(2026, month - 1, day) + parseTimestampMs(r.dateStr, r.timeStr)
    const fields = fieldsOf(r.body)
    out.push({
      tMs,
      pid: r.pid,
      level: LEVEL.exec(r.body)?.[1] ?? 'INFO',
      code,
      fields,
      hand: fields.hand ?? HAND_BY_ADDRESS[fields.deviceId],
      body: r.body,
    })
  }
  return out
}

/**
 * Every successful glove connect in one capture, and how its link ended.
 *
 * A link is followed only inside the app run that made it: a new process, or
 * a JS reload in the same one (`keepalive.started`), ends the run. Its last
 * activity bounds the drop to the heartbeat that never came.
 *
 *   log-ended      the capture stopped while the link was alive
 *   app-restarted  the app run ended while the link was alive
 *   drop-logged    the transport logged the disconnect
 *   went-silent    the app ran on, and the glove was never touched again
 */
export function gloveLinks(records, file = '') {
  const links = []
  const lastT = records.length ? records[records.length - 1].tMs : 0
  records.forEach((connect, index) => {
    if (connect.code !== 'ble.slot.connect.ok') return
    const later = records.slice(index + 1)
    // The end of this app run: another process, or this one starting over.
    const runEnd = later.find((r) => r.pid !== connect.pid || RUNTIME_START.test(r.code))
    const run = later.filter((r) => r.pid === connect.pid && (!runEnd || r.tMs < runEnd.tMs))
    const nextConnect = run.find((r) => r.code === 'ble.slot.connect.ok' && r.hand === connect.hand)
    const mine = run.filter((r) => r.hand === connect.hand && (!nextConnect || r.tMs < nextConnect.tMs))
    const acts = mine.filter((r) => ACTIVITY.test(r.code))
    const last = acts.length ? acts[acts.length - 1].tMs : connect.tMs
    const runLast = run.length ? run[run.length - 1].tMs : connect.tMs
    const dropLine = mine.find((r) => r.code === 'ble.device.disconnected')
    const next = mine.find((r) => r.tMs > last && !ACTIVITY.test(r.code) && !r.code.endsWith('attempt'))

    let reason
    if (dropLine) reason = 'drop-logged'
    else if (runLast - last > SILENCE_SLACK_MS) reason = 'went-silent'
    else reason = runEnd || runLast < lastT - 1_000 ? 'app-restarted' : 'log-ended'

    links.push({
      file,
      hand: connect.hand,
      atMs: connect.tMs,
      seenAliveMs: Math.round(last - connect.tMs),
      initWrites: acts.filter((r) => r.code === 'punchstream.write.ok').length,
      heartbeats: acts.filter((r) => r.code === 'ble.write.ok').length,
      reason,
      appRanOnMs: Math.round(runLast - last),
      next: next ? next.code : '',
      dropError: dropLine ? String(dropLine.fields.errorMessage ?? '') : '',
    })
  })
  return links
}

/** The same connect turns up in overlapping captures; keep the longest view. */
export function mergeLinks(links) {
  const best = new Map()
  for (const link of links) {
    const key = `${link.hand}@${link.atMs}`
    const prior = best.get(key)
    if (!prior || link.seenAliveMs + link.appRanOnMs > prior.seenAliveMs + prior.appRanOnMs) {
      best.set(key, link)
    }
  }
  return [...best.values()].sort((a, b) => a.atMs - b.atMs)
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]

/** n / median / p90 / max of a list of durations, or null when it is empty. */
export function spread(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    medianMs: Math.round(percentile(sorted, 0.5)),
    p90Ms: Math.round(percentile(sorted, 0.9)),
    maxMs: Math.round(sorted[sorted.length - 1]),
  }
}

/**
 * Timings and tallies over many captures' records. `seen` carries the keys
 * of records already counted, so a record present in two overlapping
 * captures is counted once.
 */
export function tallyRecords(records, tally = emptyTally()) {
  for (const r of records) {
    const f = r.fields
    const key = `${r.tMs}|${r.code}|${f.deviceId ?? f.hand ?? ''}|${f.label ?? f.characteristicUuid ?? ''}`
    if (tally.seen.has(key)) continue
    tally.seen.add(key)
    if (r.code === 'punchstream.write.ok') (tally.initWriteMs[f.label] ??= []).push(f.durationMs)
    else if (r.code === 'ble.write.ok' && String(f.characteristicUuid).startsWith('ca281071')) {
      if (f.byteCount === 1 && r.hand) (tally.heartbeatMs[r.hand] ??= []).push(f.durationMs)
    } else if (r.code === 'keepalive.deviceInfo') {
      const hex = /valueHex:\s*'?([0-9a-fA-F]+)/.exec(r.body)?.[1] ?? '?'
      const k = `${r.hand} ${hex}`
      tally.deviceInfo[k] = (tally.deviceInfo[k] ?? 0) + 1
    } else if (r.code === 'keepalive.battery' && r.hand) (tally.batteryPct[r.hand] ??= []).push(f.pct)
    else if (r.code === 'ble.connect.failed') {
      const message = String(f.errorMessage ?? '').replace(/[0-9A-F]{2}(:[0-9A-F]{2}){5}/, '<addr>')
      const k = `${HAND_BY_ADDRESS[f.deviceId] ?? '?'} | ${message} | android ${f.androidErrorCode}`
      tally.connectFailures[k] = (tally.connectFailures[k] ?? 0) + 1
    } else if (/\.runner\.start$/.test(r.code)) {
      tally.punchSource[f.source] = (tally.punchSource[f.source] ?? 0) + 1
    }
  }
  return tally
}

export function emptyTally() {
  return {
    seen: new Set(),
    initWriteMs: {},
    heartbeatMs: {},
    deviceInfo: {},
    batteryPct: {},
    connectFailures: {},
    punchSource: {},
  }
}

/** Every capture file under `dir`, any depth. */
export function captureFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (['.txt', '.log', '.monlog'].includes(extname(entry.name))) out.push(p)
    }
  }
  walk(dir)
  return out
}

/** Mine every capture under `dir`. */
export function mine(dir) {
  const links = []
  const tally = emptyTally()
  let files = 0
  for (const file of captureFiles(dir)) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!text.includes('ReactNativeJS')) continue
    const records = appRecords(text)
    if (records.length === 0) continue
    files += 1
    links.push(...gloveLinks(records, relative(dir, file).split(sep).join('/')))
    tallyRecords(records, tally)
  }
  return { files, links: mergeLinks(links), tally }
}

function report({ files, links, tally }, showLinks) {
  const lines = [`captures with app logs: ${files}`, `distinct glove links: ${links.length}`]
  const byReason = {}
  for (const l of links) byReason[l.reason] = (byReason[l.reason] ?? 0) + 1
  lines.push(`  how they ended: ${JSON.stringify(byReason)}`)
  lines.push(`  seen alive past 45 s: ${links.filter((l) => l.seenAliveMs > 45_000).length}`)
  lines.push(
    `  by hand: ${['left', 'right'].map((h) => `${h} ${links.filter((l) => l.hand === h).length}`).join(', ')}`,
  )
  const show = (name, values) => {
    const s = spread(values)
    if (s) lines.push(`  ${name.padEnd(34)} n=${s.n}  median ${s.medianMs} ms  p90 ${s.p90Ms} ms  max ${s.maxMs} ms`)
  }
  lines.push('init writes:')
  for (const [label, values] of Object.entries(tally.initWriteMs)) show(label, values)
  lines.push('heartbeat write:')
  for (const [hand, values] of Object.entries(tally.heartbeatMs)) show(hand, values)
  lines.push(`device-info values: ${JSON.stringify(tally.deviceInfo)}`)
  lines.push(`workout runs by punch source: ${JSON.stringify(tally.punchSource)}`)
  lines.push('connect failures:')
  for (const [k, n] of Object.entries(tally.connectFailures).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(n).padStart(5)}  ${k}`)
  }
  if (showLinks) {
    lines.push('links:')
    for (const l of links) {
      lines.push(
        `  ${new Date(l.atMs).toISOString().slice(5, 16)}  ${String(l.hand).padEnd(5)}  ${(l.seenAliveMs / 1000).toFixed(1).padStart(7)} s  ${l.reason.padEnd(13)}  ${l.file}`,
      )
    }
  }
  return lines.join('\n')
}

// Not `import.meta.url`: jest transforms this file and leaves that empty.
const invokedDirectly = process.argv[1]?.endsWith('mine-ble-logs.mjs')
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const dir = args.find((a) => !a.startsWith('--')) ?? join('tools', 'analysis')
  const result = mine(dir)
  if (args.includes('--json')) {
    console.info(JSON.stringify({ ...result, tally: { ...result.tally, seen: undefined } }, null, 2))
  } else {
    console.info(report(result, args.includes('--links')))
  }
}
