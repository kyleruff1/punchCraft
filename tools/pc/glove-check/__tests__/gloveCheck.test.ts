import { addSink, replaceSinks } from '@diagnostics/logger'
import { CHAR } from '@protocol/fightcamp-v1/FightCampV1Commands'
import { FightCampV1Adapter } from '@protocol/fightcamp-v1/FightCampV1Adapter'
import {
  BATTERY_LEVEL_UUID,
  HEARTBEAT_INTERVAL_MS,
} from '@protocol/fightcamp-v1/FightCampV1Keepalive'

import {
  CONNECT_TIMEOUT_MS,
  GloveCheck,
  MAX_RECONNECTS,
  PICK_OPTIONS,
  RECONNECT_DELAY_MS,
} from '../gloveCheck'
import { SYSTEM_ID_UUID } from '../gloveIdentity'
import { buildReport } from '../report'
import { fakeFacade } from './helpers/fakeFacade'

const LEFT = { deviceId: 'opaque-left', name: 'FightCam' }
const RIGHT = { deviceId: 'opaque-right', name: 'FightCam' }
/** EA:69:2D:9C:FD:53 — the right (red) tracker — as an address-derived System ID. */
const RIGHT_SYSTEM_ID = '53fd9cfeff2d69ea'

const now = (): number => Date.now()
const settle = (): Promise<void> => jest.advanceTimersByTimeAsync(0)
const advance = (ms: number): Promise<void> => jest.advanceTimersByTimeAsync(ms)

function setup() {
  const f = fakeFacade(now)
  for (const device of [LEFT, RIGHT]) {
    f.setRead(device.deviceId, CHAR.DEVICE_INFO_READ, '0000')
    f.setRead(device.deviceId, BATTERY_LEVEL_UUID, '4e')
  }
  let changes = 0
  const check = new GloveCheck({
    facade: f.facade,
    adapter: new FightCampV1Adapter(),
    now,
    onChange: () => (changes += 1),
  })
  check.start()
  const connect = async (hand: 'left' | 'right', device = hand === 'left' ? LEFT : RIGHT) => {
    f.willPick(device)
    await check.connect(hand)
  }
  const writesTo = (deviceId: string) =>
    f.writes.filter((w) => w.deviceId === deviceId).map((w) => [w.characteristicUuid, w.hex])
  return { f, check, connect, writesTo, changes: () => changes }
}

/** One 9-byte punch record stamped `agoMs` before the fake clock's now. */
function punchHex(agoMs: number, velocityByte = 40): string {
  const stampMs = Date.now() - agoMs
  const secs = Math.floor(stampMs / 1000)
  const sub = Math.round(((stampMs % 1000) * 256) / 1000) & 0xff
  const bytes = [3, 0x02, 0x01, secs & 0xff, (secs >>> 8) & 0xff, (secs >>> 16) & 0xff]
  bytes.push((secs >>> 24) & 0xff, sub, velocityByte)
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-11-25T12:00:00.500Z'))
})

afterEach(() => {
  jest.useRealTimers()
  replaceSinks([])
})

describe('bringing a glove up', () => {
  it('asks the chooser for the gloves by service and by name', async () => {
    const h = setup()
    await h.connect('left')
    expect(h.f.pickRequests).toEqual([PICK_OPTIONS])
    expect(PICK_OPTIONS.namePrefixes).toEqual(['FightCam'])
  })

  it('runs the real init plan, in order, as the hand that was clicked', async () => {
    const h = setup()
    await h.connect('left')
    const g = h.check.glove('left')
    expect(g.phase).toBe('streaming')
    expect(g.initErrors).toEqual([])
    expect(g.subscribedChars).toEqual([CHAR.DATA_STREAM, CHAR.NOTIFY_STATUS, CHAR.COMMAND_ACK])
    const writes = h.writesTo(LEFT.deviceId)
    expect(writes.map(([uuid]) => uuid)).toEqual([
      CHAR.CLOCK_SYNC,
      CHAR.COMMAND1,
      CHAR.COMMAND2,
      CHAR.COMMAND1,
    ])
    // mode-normal, hand = left (2), command 17
    expect(writes.slice(1).map(([, hex]) => hex)).toEqual(['01', '02', '11'])
    expect(g.batteryPct).toBe(78)
    expect(g.trackerInfoHex).toBe('0000')
  })

  it('writes the right-hand byte for the right glove', async () => {
    const h = setup()
    await h.connect('right')
    expect(h.writesTo(RIGHT.deviceId)[2]).toEqual([CHAR.COMMAND2, '01'])
  })

  it('puts the init steps on the timeline as the stream reports them', async () => {
    const h = setup()
    addSink(h.check.logSink())
    await h.connect('left')
    const lines = h.check.glove('left').timeline.map((entry) => entry.text)
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('init-clockSync-ca281079'),
        expect.stringContaining('init-command17-ca281071'),
        expect.stringContaining('init plan finished: 3 subscriptions, no errors'),
      ]),
    )
  })

  it('goes back to idle when the chooser is closed', async () => {
    const h = setup()
    await h.check.connect('left')
    expect(h.check.glove('left').phase).toBe('idle')
    expect(h.check.glove('left').message).toMatch(/No glove chosen/)
    expect(h.f.writes).toEqual([])
  })

  it('refuses one glove for both hands', async () => {
    const h = setup()
    await h.connect('left')
    await h.connect('right', LEFT)
    expect(h.check.glove('right').phase).toBe('idle')
    expect(h.check.glove('right').message).toMatch(/already connected as the left glove/)
    expect(h.check.glove('left').phase).toBe('streaming')
  })
})

describe('telling the gloves apart', () => {
  it('hangs up a glove known to be the other hand before writing anything', async () => {
    const h = setup()
    h.f.setRead(RIGHT.deviceId, SYSTEM_ID_UUID, RIGHT_SYSTEM_ID)
    await h.connect('left', RIGHT)
    await settle()
    const g = h.check.glove('left')
    expect(g.phase).toBe('wrong-glove')
    expect(g.message).toMatch(/That is the right glove \(red\).*Nothing was written/)
    expect(h.f.writes).toEqual([])
    expect(h.f.isConnected(RIGHT.deviceId)).toBe(false)
    expect(h.check.verdict('left')).toBe('unknown')
    expect(h.check.canConnect('left')).toBe(true)
  })

  it('carries on when the System ID confirms the button', async () => {
    const h = setup()
    h.f.setRead(RIGHT.deviceId, SYSTEM_ID_UUID, RIGHT_SYSTEM_ID)
    await h.connect('right')
    const g = h.check.glove('right')
    expect(g.phase).toBe('streaming')
    expect(g.identified).toMatchObject({ hand: 'right', address: 'EA:69:2D:9C:FD:53' })
  })

  it('trusts the button when the System ID cannot be read', async () => {
    const h = setup()
    await h.connect('left')
    expect(h.check.glove('left').identified).toBeNull()
    expect(h.check.glove('left').phase).toBe('streaming')
  })
})

describe('what comes back', () => {
  it('decodes a punch through the real decoder and times it', async () => {
    const h = setup()
    await h.connect('left')
    h.f.emitFrame(LEFT.deviceId, punchHex(250), new Date().toISOString())
    const g = h.check.glove('left')
    expect(g.punchCount).toBe(1)
    expect(g.punches[0]).toMatchObject({
      velocityRaw: 40,
      unit: 'tracker-unit',
      recovered: false,
    })
    // 250 ms, give or take the tracker's 1/256 s timestamp step.
    expect(Math.abs((g.punches[0]?.latencyMs ?? 0) - 250)).toBeLessThanOrEqual(4)
  })

  it('marks a punch the glove had buffered as recovered, and leaves it out of latency', async () => {
    const h = setup()
    await h.connect('left')
    h.f.emitFrame(LEFT.deviceId, punchHex(30_000), new Date().toISOString())
    h.f.emitFrame(LEFT.deviceId, punchHex(100), new Date().toISOString())
    expect(h.check.glove('left').punches.map((p) => p.recovered)).toEqual([true, false])
    const report = buildReport(h.check, {
      wallTimeIso: 'T',
      userAgent: 'jest',
      bluetoothAvailable: true,
    })
    expect(report).toMatch(/latency, 1 live punches: median 1\d\d ms/)
    expect(report).toContain('punches: 2 (frames 2, malformed 0, unknown 0)')
  })

  it('keeps every raw frame, including one the decoder rejects', async () => {
    const h = setup()
    await h.connect('left')
    h.f.emitFrame(LEFT.deviceId, punchHex(100), new Date().toISOString())
    h.f.emitFrame(LEFT.deviceId, '0102030405', new Date().toISOString())
    const g = h.check.glove('left')
    expect(g.frames).toBe(2)
    expect(g.malformed).toBe(1)
    expect(g.punchCount).toBe(1)
    expect(h.check.capturedFrames().frames.map((f) => f.valueHex)).toEqual([
      expect.any(String),
      '0102030405',
    ])
  })

  it('sends the keepalive beat every 20 s: mode-normal, then a battery read', async () => {
    const h = setup()
    await h.connect('left')
    const before = h.f.writes.length
    h.f.setRead(LEFT.deviceId, BATTERY_LEVEL_UUID, '4d')
    await advance(HEARTBEAT_INTERVAL_MS)
    expect(h.writesTo(LEFT.deviceId).slice(before)).toEqual([[CHAR.COMMAND1, '01']])
    expect(h.check.glove('left').heartbeatsSent).toBe(1)
    expect(h.check.glove('left').batteryPct).toBe(77)
  })
})

describe('the not-bonded signature', () => {
  it('is suspect after one drop at 37 s, reconnects, and stops after the second', async () => {
    const h = setup()
    await h.connect('left')
    await advance(37_000)
    h.f.drop(LEFT.deviceId)
    expect(h.check.verdict('left')).toBe('suspect')
    expect(h.check.glove('left').phase).toBe('dropped')
    expect(h.check.glove('left').links[0]).toMatchObject({ signature: true, byUser: false })

    await advance(RECONNECT_DELAY_MS)
    expect(h.check.glove('left').phase).toBe('streaming')
    await advance(37_000)
    h.f.drop(LEFT.deviceId)
    expect(h.check.verdict('left')).toBe('probably-unbonded')
    expect(h.check.glove('left').phase).toBe('failed')
    expect(h.check.glove('left').message).toMatch(/Stopped reconnecting.*2 times in a row/)

    await advance(60_000)
    expect(h.f.isConnected(LEFT.deviceId)).toBe(false)
    expect(h.check.canConnect('left')).toBe(true)
    const report = buildReport(h.check, {
      wallTimeIso: 'T',
      userAgent: 'jest',
      bluetoothAvailable: true,
    })
    expect(report).toContain('DROPPED IN THE NOT-BONDED WINDOW')
    expect(report).toContain('Pair "FightCam" in Windows Settings')
  })

  it('says holding once a link outlives the window, and a later drop is just a drop', async () => {
    const h = setup()
    await h.connect('left')
    await advance(46_000)
    expect(h.check.verdict('left')).toBe('holding')
    expect(h.check.glove('left').timeline.map((e) => e.text)).toContain(
      'held past 45 s: the link is secure',
    )
    await advance(60_000)
    h.f.drop(LEFT.deviceId)
    expect(h.check.verdict('left')).toBe('unknown')
    expect(h.check.glove('left').links[0]?.signature).toBe(false)
    await advance(RECONNECT_DELAY_MS)
    expect(h.check.glove('left').phase).toBe('streaming')
  })

  it('does not count a hang-up from the page, even at 37 s', async () => {
    const h = setup()
    await h.connect('left')
    await advance(37_000)
    await h.check.disconnect('left')
    expect(h.check.verdict('left')).toBe('unknown')
    expect(h.check.glove('left').phase).toBe('idle')
    expect(h.check.glove('left').links[0]).toMatchObject({ byUser: true, signature: false })
    await advance(60_000)
    expect(h.f.isConnected(LEFT.deviceId)).toBe(false)
  })
})

describe('when the link will not come up', () => {
  it('retries a failed connect after a pause', async () => {
    const h = setup()
    h.f.failNextConnect(new Error('GATT Error Unknown.'))
    await h.connect('left')
    const g = h.check.glove('left')
    expect(g.phase).toBe('dropped')
    expect(g.message).toMatch(/Could not connect \(GATT Error Unknown\.\)/)
    expect(h.check.verdict('left')).toBe('unknown')
    await advance(RECONNECT_DELAY_MS)
    expect(g.phase).toBe('streaming')
    expect(g.message).toBeNull()
  })

  it('gives up on a connect that never answers, then tries again', async () => {
    const h = setup()
    h.f.hangNextConnect()
    h.f.willPick(LEFT)
    void h.check.connect('left')
    await settle()
    expect(h.check.glove('left').phase).toBe('connecting')
    await advance(CONNECT_TIMEOUT_MS)
    expect(h.check.glove('left').phase).toBe('dropped')
    expect(h.check.glove('left').message).toMatch(/no answer in 25\.0 s/)
    await advance(RECONNECT_DELAY_MS)
    expect(h.check.glove('left').phase).toBe('streaming')
  })

  it('stops after too many reconnects in a row', async () => {
    const h = setup()
    for (let i = 0; i <= MAX_RECONNECTS; i++) h.f.failNextConnect(new Error('nope'))
    await h.connect('left')
    await advance(RECONNECT_DELAY_MS * (MAX_RECONNECTS + 1))
    const g = h.check.glove('left')
    expect(g.phase).toBe('failed')
    expect(g.message).toMatch(/Stopped after 6 reconnects/)
    expect(h.f.writes).toEqual([])
  })

  it('lets Disconnect cancel a connect that is still waiting', async () => {
    const h = setup()
    h.f.hangNextConnect()
    h.f.willPick(LEFT)
    void h.check.connect('left')
    await settle()
    await h.check.disconnect('left')
    await settle()
    expect(h.check.glove('left').phase).toBe('idle')
    await advance(CONNECT_TIMEOUT_MS + RECONNECT_DELAY_MS)
    expect(h.f.isConnected(LEFT.deviceId)).toBe(false)
    expect(h.check.glove('left').phase).toBe('idle')
  })
})

describe('two gloves', () => {
  it('brings them up one at a time', async () => {
    const h = setup()
    h.f.hangNextConnect()
    h.f.willPick(LEFT)
    void h.check.connect('left')
    await settle()
    h.f.willPick(RIGHT)
    void h.check.connect('right')
    await settle()
    // Left is still mid-connect, so right has not been touched.
    expect(h.check.glove('right').phase).toBe('waiting')
    expect(h.f.isConnected(RIGHT.deviceId)).toBe(false)
    await advance(CONNECT_TIMEOUT_MS)
    expect(h.check.glove('right').phase).toBe('streaming')
    await advance(RECONNECT_DELAY_MS)
    expect(h.check.glove('left').phase).toBe('streaming')
  })

  it('beats both, and reports both', async () => {
    const h = setup()
    await h.connect('left')
    await h.connect('right')
    await advance(HEARTBEAT_INTERVAL_MS)
    expect(h.check.glove('left').heartbeatsSent).toBe(1)
    expect(h.check.glove('right').heartbeatsSent).toBe(1)
    const report = buildReport(h.check, {
      wallTimeIso: '2026-11-25T12:00:00.000Z',
      userAgent: 'jest',
      bluetoothAvailable: null,
    })
    expect(report).toContain('LEFT glove: "FightCam", streaming')
    expect(report).toContain('RIGHT glove: "FightCam", streaming')
    expect(report).toContain('bluetooth available: not asked')
    expect(report).toContain('heartbeats: 1 sent, 0 failed')
  })

  it('says so for a glove that was never tried', () => {
    const h = setup()
    const report = buildReport(h.check, {
      wallTimeIso: 'T',
      userAgent: 'jest',
      bluetoothAvailable: false,
    })
    expect(report).toContain('LEFT glove: not tried')
    expect(report).toContain('bluetooth available: NO')
  })
})
