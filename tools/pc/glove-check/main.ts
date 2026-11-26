/**
 * The glove check page: builds the real transport over `navigator.bluetooth`,
 * hands it to `GloveCheck`, and draws whatever state that reports. All of the
 * behaviour is in `gloveCheck.ts`; this file is DOM only.
 */
import { BleManagerWebBluetoothImpl, type WebBluetooth } from '@ble/BleManagerWebBluetoothImpl'
import { knownTrackerForHand } from '@ble/knownTrackers'
import { addSink } from '@diagnostics/logger'
import { FightCampV1Adapter } from '@protocol/fightcamp-v1/FightCampV1Adapter'

import { GloveCheck, type GlovePhase, type Hand } from './gloveCheck'
import { buildReport, latencySummary, verdictSentence } from './report'
import { statusSentence } from './statusByte'

const HANDS: readonly Hand[] = ['left', 'right']
const ROWS_SHOWN = 12

const PHASE_TEXT: Record<GlovePhase, string> = {
  idle: 'Not connected',
  choosing: 'Pick the glove in the browser…',
  waiting: 'Waiting for the other glove to finish…',
  connecting: 'Connecting…',
  identifying: 'Checking which glove this is…',
  initialising: 'Running the start-up…',
  streaming: 'Connected — throw a punch',
  dropped: 'Dropped — reconnecting…',
  'wrong-glove': 'Wrong glove for this button',
  failed: 'Stopped',
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

const bluetooth = (navigator as Navigator & { bluetooth?: WebBluetooth }).bluetooth
let bluetoothAvailable: boolean | null = null

function explainEnvironment(): void {
  const banner = $('banner')
  if (!window.isSecureContext) {
    banner.textContent =
      'This page is not a secure context, so the browser hides Bluetooth. Open it at the http://127.0.0.1 address the command printed.'
  } else if (!bluetooth) {
    banner.textContent =
      'This browser has no Web Bluetooth. Open this page in Chrome or Edge on this PC.'
  }
}

function buildPanel(hand: Hand): HTMLElement {
  const template = $<HTMLTemplateElement>('glove-template')
  const panel = (template.content.cloneNode(true) as DocumentFragment)
    .firstElementChild as HTMLElement
  const tracker = knownTrackerForHand(hand)
  panel.dataset.hand = hand
  panel.querySelector('.swatch')?.classList.add(tracker?.color ?? 'blue')
  field(panel, 'title').textContent =
    `${hand === 'left' ? 'Left' : 'Right'} glove — ${tracker?.color ?? ''}`
  action(panel, 'connect').textContent = `Connect ${hand} glove`
  return panel
}

const field = (panel: HTMLElement, name: string): HTMLElement =>
  panel.querySelector(`[data-f="${name}"]`) as HTMLElement
const action = (panel: HTMLElement, name: string): HTMLButtonElement =>
  panel.querySelector(`[data-a="${name}"]`) as HTMLButtonElement

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement('td')
  td.textContent = text
  return td
}

function draw(check: GloveCheck, panels: Record<Hand, HTMLElement>): void {
  for (const hand of HANDS) {
    const panel = panels[hand]
    const g = check.glove(hand)
    const verdict = check.verdict(hand)
    const age = check.linkAgeMs(hand)

    field(panel, 'status').textContent = PHASE_TEXT[g.phase]
    field(panel, 'message').textContent = g.message ?? ''
    const verdictEl = field(panel, 'verdict')
    verdictEl.textContent = verdictSentence(verdict, g.bond.signatureDrops)
    verdictEl.className = `verdict ${verdict}`
    field(panel, 'link').textContent =
      age !== null
        ? `up ${secs(age)} (connection ${g.links.length})`
        : g.links.length > 0
          ? `down — ${g.links.length} connection${g.links.length === 1 ? '' : 's'} so far`
          : '—'
    field(panel, 'identity').textContent = g.identified
      ? `${g.identified.color} = ${g.identified.hand}, read from the glove (${g.identified.address})`
      : g.systemIdHex
        ? `could not tell from System ID ${g.systemIdHex}; going by the button`
        : g.deviceId
          ? 'going by the button'
          : '—'
    field(panel, 'init').textContent = !g.deviceId
      ? '—'
      : `${g.subscribedChars.length} subscriptions; ` +
        (g.initErrors.length === 0 ? 'no errors' : g.initErrors.join('; '))
    field(panel, 'battery').textContent = g.batteryPct === null ? '—' : `${g.batteryPct}%`
    const statusHex = g.statusAfterHex ?? g.statusBeforeHex
    const pushed = g.statusNotifications.length
    const errors = g.errorStrings.length
    field(panel, 'statusByte').textContent = !g.deviceId
      ? '—'
      : statusSentence(statusHex) +
        (g.statusAfterHex !== null &&
        g.statusBeforeHex !== null &&
        g.statusAfterHex !== g.statusBeforeHex
          ? ` (was 0x${g.statusBeforeHex} before start-up)`
          : '') +
        (pushed > 0 ? ` · pushed ${pushed}×` : '') +
        (errors > 0 ? ` · ${errors} error string${errors === 1 ? '' : 's'} — see the timeline` : '')
    field(panel, 'heartbeat').textContent =
      `${g.heartbeatsSent} sent` + (g.heartbeatsFailed > 0 ? `, ${g.heartbeatsFailed} failed` : '')
    field(panel, 'punches').textContent =
      `${g.punchCount} (frames ${g.frames}, malformed ${g.malformed})`
    const latency = latencySummary(g.punches)
    field(panel, 'latency').textContent = latency
      ? `median ${latency.medianMs} ms, ${latency.minMs}–${latency.maxMs} ms over ${latency.count}`
      : '—'
    const info = Object.entries(g.deviceInformation).map(([k, v]) => `${k}: ${v}`)
    if (g.trackerInfoHex) info.push(`tracker info: ${g.trackerInfoHex}`)
    field(panel, 'info').textContent = info.length > 0 ? info.join(' · ') : '—'

    const t0 = g.timeline[0]?.atMs ?? 0
    field(panel, 'rows').replaceChildren(
      ...g.punches
        .slice(-ROWS_SHOWN)
        .reverse()
        .map((row) => {
          const tr = document.createElement('tr')
          tr.append(
            cell(`+${secs(row.atMs - t0)}${row.recovered ? ' (buffered)' : ''}`),
            cell(row.velocityRaw === null ? '—' : String(row.velocityRaw)),
            cell(row.velocity === null ? '—' : row.velocity.toFixed(1)),
            cell(row.latencyMs === null ? '—' : `${Math.round(row.latencyMs)} ms`),
          )
          return tr
        }),
    )

    const timeline = field(panel, 'timeline')
    if (timeline.childElementCount !== g.timeline.length) {
      timeline.replaceChildren(
        ...g.timeline.map((entry) => {
          const li = document.createElement('li')
          const time = document.createElement('time')
          time.textContent = `+${((entry.atMs - t0) / 1000).toFixed(2)}`
          li.append(time, entry.text)
          return li
        }),
      )
      timeline.scrollTop = timeline.scrollHeight
    }

    action(panel, 'connect').disabled = !bluetooth || !check.canConnect(hand)
    action(panel, 'disconnect').disabled = !check.canDisconnect(hand)
  }
}

function reportText(check: GloveCheck): string {
  return buildReport(check, {
    wallTimeIso: new Date().toISOString(),
    userAgent: navigator.userAgent,
    bluetoothAvailable,
  })
}

function downloadFrames(check: GloveCheck): void {
  const { frames } = check.capturedFrames()
  const blob = new Blob([frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n'], {
    type: 'application/x-ndjson',
  })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `glove-check-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  link.click()
  URL.revokeObjectURL(link.href)
}

function boot(): void {
  explainEnvironment()
  const panels = { left: buildPanel('left'), right: buildPanel('right') }
  $('gloves').append(panels.left, panels.right)

  // With no Web Bluetooth the page still loads, to say why nothing works.
  const facade = new BleManagerWebBluetoothImpl({
    bluetooth: bluetooth ?? {
      requestDevice: () => Promise.reject(new Error('this browser has no Web Bluetooth')),
    },
  })
  facade.setCaptureIdProvider(() => 'glove-check')

  let queued = false
  const check: GloveCheck = new GloveCheck({
    facade,
    adapter: new FightCampV1Adapter(),
    onChange: () => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        draw(check, panels)
      })
    },
  })
  addSink(check.logSink())
  check.start()

  for (const hand of HANDS) {
    // The chooser needs the click itself: call connect() straight from it.
    action(panels[hand], 'connect').addEventListener('click', () => void check.connect(hand))
    action(panels[hand], 'disconnect').addEventListener('click', () => void check.disconnect(hand))
  }

  $('copy').addEventListener('click', () => {
    const text = reportText(check)
    const box = $<HTMLTextAreaElement>('report')
    box.value = text
    box.hidden = false
    void navigator.clipboard?.writeText(text).then(
      () => ($('copy').textContent = 'Copied'),
      () => box.select(),
    )
  })
  $('download').addEventListener('click', () => downloadFrames(check))

  const env = $('env')
  env.textContent = 'Bluetooth: checking…'
  void facade.isReady().then((ready) => {
    bluetoothAvailable = bluetooth ? ready : false
    env.textContent = bluetoothAvailable
      ? 'Bluetooth: available'
      : 'Bluetooth: not available — is it switched on?'
  })

  window.addEventListener('beforeunload', () => check.stop())
  draw(check, panels)
}

boot()
