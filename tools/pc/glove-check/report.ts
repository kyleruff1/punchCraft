/**
 * The glove check's words: the verdict sentence, the latency summary, and the
 * plain-text report behind "Copy report". Pure — no DOM.
 */
import { UNBONDED_DROP_WINDOW_MS, type BondVerdict } from '@ble/bondDiagnosis'

import { UNBONDED_WINDOW_TEXT, type GloveState, type Hand, type PunchRow } from './gloveCheck'

const HOLD_SECONDS = UNBONDED_DROP_WINDOW_MS.max / 1000

/** What the bond verdict means, for someone standing at the PC. */
export function verdictSentence(verdict: BondVerdict, signatureDrops: number): string {
  switch (verdict) {
    case 'holding':
      return `Holding: past ${HOLD_SECONDS} s, so the glove's security request was answered. This PC can hold it.`
    case 'suspect':
      return `Dropped once inside ${UNBONDED_WINDOW_TEXT}. That is how an unbonded glove behaves; one more and it is near certain.`
    case 'probably-unbonded':
      return (
        `Dropped inside ${UNBONDED_WINDOW_TEXT} ${signatureDrops} times in a row: almost certainly not bonded to this PC. ` +
        'Pair "FightCam" in Windows Settings > Bluetooth & devices > Add device, then connect again.'
      )
    case 'unknown':
      return `No verdict yet. A link has to hold past ${HOLD_SECONDS} s, or drop inside ${UNBONDED_WINDOW_TEXT}.`
  }
}

export interface LatencySummary {
  count: number
  medianMs: number
  minMs: number
  maxMs: number
}

/** Latency of the punches that arrived live — late, buffered ones excluded. */
export function latencySummary(rows: readonly PunchRow[]): LatencySummary | null {
  const live = rows
    .filter((row) => !row.recovered && row.latencyMs !== null)
    .map((row) => row.latencyMs as number)
    .sort((a, b) => a - b)
  if (live.length === 0) return null
  const mid = Math.floor(live.length / 2)
  const median = live.length % 2 === 1 ? live[mid]! : (live[mid - 1]! + live[mid]!) / 2
  return {
    count: live.length,
    medianMs: Math.round(median),
    minMs: Math.round(live[0]!),
    maxMs: Math.round(live[live.length - 1]!),
  }
}

export interface ReportSource {
  glove(hand: Hand): GloveState
  verdict(hand: Hand): BondVerdict
  capturedFrames(): { frames: readonly unknown[]; dropped: number }
}

export interface ReportEnvironment {
  wallTimeIso: string
  userAgent: string
  /** What `navigator.bluetooth.getAvailability()` said, or null if not asked. */
  bluetoothAvailable: boolean | null
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

function gloveSection(source: ReportSource, hand: Hand): string[] {
  const g = source.glove(hand)
  const title = `${hand.toUpperCase()} glove`
  if (!g.deviceId) return [`${title}: not tried`, '']
  const lines = [`${title}: "${g.deviceName ?? 'unnamed'}", ${g.phase}`]
  lines.push(
    g.identified
      ? `  identity: System ID carries ${g.identified.address} = the ${g.identified.hand} glove (${g.identified.color})`
      : `  identity: not derivable (System ID ${g.systemIdHex ?? 'not read'})`,
  )
  lines.push(`  verdict: ${verdictSentence(source.verdict(hand), g.bond.signatureDrops)}`)
  lines.push(`  links: ${g.links.length}`)
  g.links.forEach((link, i) => {
    const held =
      link.endedAtMs === null ? 'still up' : `held ${secs(link.endedAtMs - link.readyAtMs)}`
    const how =
      link.endedAtMs === null
        ? ''
        : link.byUser
          ? ', hung up from the page'
          : link.signature
            ? ', DROPPED IN THE NOT-BONDED WINDOW'
            : ', dropped'
    lines.push(`    #${i + 1} ${held}${how}`)
  })
  lines.push(
    `  init: ${g.subscribedChars.length} subscriptions; errors: ${
      g.initErrors.length === 0 ? 'none' : g.initErrors.join('; ')
    }`,
  )
  lines.push(`  tracker info blob: ${g.trackerInfoHex ?? 'not read'}`)
  const info = Object.entries(g.deviceInformation)
  lines.push(
    `  device information: ${info.length === 0 ? 'none read' : info.map(([k, v]) => `${k}=${v}`).join(', ')}`,
  )
  lines.push(`  battery: ${g.batteryPct === null ? 'not read' : `${g.batteryPct}%`}`)
  const latency = latencySummary(g.punches)
  lines.push(
    `  punches: ${g.punchCount} (frames ${g.frames}, malformed ${g.malformed}, unknown ${g.unknown})`,
  )
  lines.push(
    latency
      ? `  latency, ${latency.count} live punches: median ${latency.medianMs} ms, ${latency.minMs}-${latency.maxMs} ms`
      : '  latency: no live punches',
  )
  lines.push(`  heartbeats: ${g.heartbeatsSent} sent, ${g.heartbeatsFailed} failed`)
  if (g.message) lines.push(`  message: ${g.message}`)
  lines.push('  timeline:')
  const t0 = g.timeline[0]?.atMs ?? 0
  for (const entry of g.timeline) {
    lines.push(`    +${((entry.atMs - t0) / 1000).toFixed(2).padStart(7)} s  ${entry.text}`)
  }
  lines.push('')
  return lines
}

/** The plain-text report, for pasting. */
export function buildReport(source: ReportSource, env: ReportEnvironment): string {
  const captured = source.capturedFrames()
  const availability =
    env.bluetoothAvailable === null ? 'not asked' : env.bluetoothAvailable ? 'yes' : 'NO'
  return [
    `punchCraft glove check — ${env.wallTimeIso}`,
    `browser: ${env.userAgent}`,
    `bluetooth available: ${availability}`,
    `raw frames kept: ${captured.frames.length}` +
      (captured.dropped > 0 ? ` (${captured.dropped} oldest dropped)` : ''),
    '',
    ...gloveSection(source, 'left'),
    ...gloveSection(source, 'right'),
  ].join('\n')
}
