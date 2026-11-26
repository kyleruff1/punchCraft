#!/usr/bin/env node
/**
 * Re-judge stored captures with TODAY's verifier and manifests.
 *
 * Every capture under tools/analysis/{suites,sessions} keeps the verdict it
 * was given when it was driven. The verifier has been tightened since, so
 * the stored verdicts answer an older question. This asks today's question
 * of the same log, and says where the answer changed and why — which is how
 * to find out what the NEXT suite drive will report without spending a
 * tablet session on it.
 *
 * It first ran by hand on 2026-11-25 and found two things: the correlator
 * could not read any pre-rename capture, and a warm-up that asked for clips
 * that cannot exist would have failed 8 of 22 workouts on the next drive.
 * Both are fixed; this is here so the next one is found the same way.
 *
 * A capture is a directory holding `logcat.txt` or `log.txt`. Its workout is
 * the directory's name (`suites/<run>/<workout>`), or that name without a
 * trailing `-<timestamp>` (`sessions/<workout>-<timestamp>`).
 *
 * Usage:
 *   node tools/analysis/rejudge-captures.mjs [dir]             tally
 *   node tools/analysis/rejudge-captures.mjs [dir] --changed   + rows whose verdict moved
 *   node tools/analysis/rejudge-captures.mjs [dir] --all       + every row
 * `dir` defaults to tools/analysis. Reads only; writes no report files.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verify } from './verify-first-round.mjs'

// `import.meta.url` is empty when jest transforms this file; a test passes
// its own directories and never needs the default.
const HERE = import.meta.url ? dirname(fileURLToPath(import.meta.url)) : join('tools', 'analysis')
const COUNTED = ['duplicated', 'wrongAsset', 'missing', 'deferred', 'assetMissing', 'playbackFailures', 'late', 'early']
const FLAGS = ['notArmed', 'noCalls', 'lowCalls', 'identityUnknown', 'stale', 'truncated', 'reanchorRegression']

/** Every directory under `dir` that holds a capture log. */
export function captureDirs(dir) {
  const out = []
  const walk = (d) => {
    const entries = readdirSync(d, { withFileTypes: true })
    if (entries.some((e) => e.isFile() && (e.name === 'logcat.txt' || e.name === 'log.txt'))) out.push(d)
    for (const e of entries) if (e.isDirectory()) walk(join(d, e.name))
  }
  walk(dir)
  return out
}

/** The workout a capture directory is of, from its name. */
export function workoutOf(captureDir) {
  return basename(captureDir).replace(/-\d{10,}$/, '')
}

/** Why a verdict is what it is, as short tokens. */
export function reasonsOf(health) {
  return [
    ...COUNTED.filter((k) => health[k] > 0).map((k) => `${k}=${health[k]}`),
    ...FLAGS.filter((k) => health[k]),
  ]
}

/**
 * Re-judge every capture under `dir` against the manifests in `manifestDir`.
 * A capture whose workout has no manifest is reported, not skipped silently.
 */
export function rejudge(dir, manifestDir = join(HERE, 'manifests')) {
  const rows = []
  for (const captureDir of captureDirs(dir)) {
    const workout = workoutOf(captureDir)
    const row = { capture: relative(dir, captureDir).split(sep).join('/'), workout, was: null, now: null, reasons: [] }
    rows.push(row)
    try {
      row.was = JSON.parse(readFileSync(join(captureDir, 'verify-report.json'), 'utf8')).health.verdict
    } catch {
      // No stored verdict: the capture was never judged, or not by this tool.
    }
    const manifestPath = join(manifestDir, `${workout}.json`)
    if (!existsSync(manifestPath)) {
      row.now = 'NO-MANIFEST'
      continue
    }
    const logPath = ['logcat.txt', 'log.txt'].map((n) => join(captureDir, n)).find((p) => existsSync(p) && statSync(p).isFile())
    try {
      const { health } = verify(JSON.parse(readFileSync(manifestPath, 'utf8')), readFileSync(logPath, 'utf8'))
      row.now = health.verdict
      row.reasons = reasonsOf(health)
      row.calls = `${health.callsDispatched ?? '?'}/${health.callsExpected ?? '?'}`
    } catch (err) {
      row.now = 'ERROR'
      row.reasons = [String(err instanceof Error ? err.message : err).slice(0, 80)]
    }
  }
  return rows
}

/** `was -> now` counts, most common first. */
export function tallyOf(rows) {
  const counts = new Map()
  for (const r of rows) {
    const key = `${r.was ?? '-'} -> ${r.now}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])
}

const invokedDirectly = process.argv[1]?.endsWith('rejudge-captures.mjs')
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const dir = args.find((a) => !a.startsWith('--')) ?? HERE
  const rows = rejudge(dir)
  console.info(`captures re-judged: ${rows.length}`)
  for (const [key, n] of tallyOf(rows)) console.info(`  ${String(n).padStart(4)}  ${key}`)
  const show = args.includes('--all') ? rows : args.includes('--changed') ? rows.filter((r) => r.was !== null && r.was !== r.now) : []
  for (const r of show) {
    console.info(
      `${r.capture.padEnd(48)} ${String(r.was ?? '-').padEnd(5)} -> ${String(r.now).padEnd(11)} calls=${r.calls ?? '-'} ${r.reasons.join(' ')}`,
    )
  }
}
