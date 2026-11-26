/**
 * The log miner, and the second capture layout it needed.
 *
 * Both layouts below are copied from real captures:
 *   -v time   tools/analysis/suites/<run>/<workout>/logcat.txt
 *     09-07 15:15:23.371 W/ReactNativeJS(17052): '[WARN] ...', '...', { hand: 'left',
 *   -v epoch  tools/analysis/monitor/<session>/log.txt
 *     1788036159.021  6644  6780 I ReactNativeJS: '[INFO] ...', '...', { deviceId: '...',
 */
import { splitLogLine, stitchLogRecords } from '../logcat.mjs'
import {
  appRecords,
  fieldsOf,
  gloveLinks,
  mergeLinks,
  spread,
  tallyRecords,
} from '../mine-ble-logs.mjs'
import { parseLogcat, verify } from '../verify-first-round.mjs'

const RIGHT = 'EA:69:2D:9C:FD:53'
const T0 = 1788036000 // epoch seconds

/** One record in the epoch layout, `at` seconds after T0. */
const epoch = (at, body, pid = 6644) =>
  `         ${(T0 + at).toFixed(3)}  ${pid}  6780 I ReactNativeJS: ${body}`
/** One record in the time layout, `at` seconds after 10:00:00. */
const time = (at, body, pid = 17052) => {
  const s = String(Math.floor(at % 60)).padStart(2, '0')
  const m = String(Math.floor(at / 60)).padStart(2, '0')
  return `09-07 10:${m}:${s}.000 I/ReactNativeJS(${pid}): ${body}`
}

const connectOk =
  "'[INFO] ble.slot.connect.ok', 'Tracker slot connected', { hand: 'right', deviceId: 'EA:69:2D:9C:FD:53' }"
const beat = `'[INFO] ble.write.ok', 'developer-mode write completed', { deviceId: '${RIGHT}', characteristicUuid: 'ca281071-5470-4e34-94dd-caf160200b29', byteCount: 1, durationMs: 104.5 }`
const chatter = "'[INFO] workout.cue.tokenDue', 'token due', { n: 1 }"

describe('the epoch log layout', () => {
  it('splits a line into the same parts as the time layout', () => {
    const line = splitLogLine(epoch(0.021, connectOk))
    expect(line).toMatchObject({ pid: 6644, epochMs: T0 * 1000 + 21, body: connectOk })
    // Given the date and time a `-v time` line would carry, in UTC.
    expect(line.dateStr).toMatch(/^\d{2}-\d{2}$/)
    expect(line.timeStr).toMatch(/^\d{2}:\d{2}:\d{2}\.021$/)
  })

  it('still reads the time layout, now with its pid', () => {
    expect(splitLogLine(time(5, connectOk))).toMatchObject({
      dateStr: '09-07',
      timeStr: '10:00:05.000',
      pid: 17052,
      epochMs: undefined,
    })
  })

  it('stitches a multi-line epoch record, as it always did for the time layout', () => {
    const text = [
      epoch(1, "'[INFO] ble.write.ok', 'developer-mode write completed', { deviceId: 'EA:69:2D:9C:FD:53',"),
      epoch(1, "  characteristicUuid: 'ca281071-5470-4e34-94dd-caf160200b29',"),
      epoch(1, '  durationMs: 104.5 }'),
      epoch(2, connectOk),
      '',
    ].join('\n')
    const records = stitchLogRecords(text)
    expect(records).toHaveLength(2)
    expect(fieldsOf(records[0].body)).toMatchObject({ deviceId: RIGHT, durationMs: 104.5 })
  })

  it('lets the correlator read a mic-monitored session, which it could not', () => {
    // The same three per-bar calls in each layout must parse to the same events.
    const capture = (stamp) =>
      [
        stamp(0, "'[INFO] workout.metronome', 'loop started', { bpm: 240 }"),
        ...[1, 2, 3].flatMap((i) => [
          stamp(i, "'[INFO] workout.clickScript.dispatch', 'click script dispatched', { kind: 'call',"),
          stamp(i, "  slot: 'call/1-2',"),
          stamp(i, '  dispatchAtMs: 1000 }'),
        ]),
        '',
      ].join('\n')
    const types = (text) => parseLogcat(text).map((e) => e.type)
    expect(types(capture(epoch))).toEqual(types(capture(time)))
    expect(types(capture(epoch)).filter((t) => t === 'clickScript.dispatch')).toHaveLength(3)
    const manifest = {
      workoutId: 'x',
      identity: { timelineHash: 'v2:0' },
      coachEvents: [],
      strikes: [],
      workDurationMs: 240_000,
      bpm: 240,
      expectedCallBars: 3,
    }
    expect(verify(manifest, capture(epoch)).health.callsDispatched).toBe(3)
  })
})

describe('gloveLinks', () => {
  const link = (lines) => gloveLinks(appRecords(lines.join('\n')), 'a.txt')

  it('follows a link to the end of the capture', () => {
    const [l] = link([time(0, connectOk), time(20, beat), time(40, beat), time(60, beat), ''])
    expect(l).toMatchObject({
      hand: 'right',
      seenAliveMs: 60_000,
      heartbeats: 3,
      reason: 'log-ended',
    })
  })

  it('says the app restarted when another process takes over', () => {
    const [l] = link([
      time(0, connectOk),
      time(20, beat),
      time(30, chatter, 999),
      time(90, chatter, 999),
      '',
    ])
    expect(l).toMatchObject({ seenAliveMs: 20_000, reason: 'app-restarted' })
  })

  it('says the app restarted on a JS reload, which keeps the process id', () => {
    const reload = "'[INFO] keepalive.started', 'tracker keepalive armed', { slots: 2 }"
    const [l] = link([time(0, connectOk), time(20, beat), time(48, reload), time(120, chatter), ''])
    expect(l.reason).toBe('app-restarted')
  })

  it('says a link went silent when the app ran on without touching the glove', () => {
    const [l] = link([time(0, connectOk), time(20, beat), time(37, chatter), time(90, chatter), ''])
    expect(l).toMatchObject({ seenAliveMs: 20_000, reason: 'went-silent', appRanOnMs: 70_000 })
  })

  it('reports a disconnect the transport logged, with its reason', () => {
    const drop = `'[INFO] ble.device.disconnected', 'device link dropped', { deviceId: '${RIGHT}', errorMessage: 'clean disconnect (no error)' }`
    const [l] = link([time(0, connectOk), time(20, beat), time(37, drop), time(90, chatter), ''])
    expect(l).toMatchObject({ reason: 'drop-logged', dropError: 'clean disconnect (no error)' })
  })

  it('times each connect of a hand on its own', () => {
    const links = link([
      time(0, connectOk),
      time(20, beat),
      time(50, connectOk),
      time(70, beat),
      time(90, beat),
      '',
    ])
    expect(links.map((l) => l.seenAliveMs)).toEqual([20_000, 40_000])
  })

  it('reads the epoch layout the same way', () => {
    const text = [epoch(0, connectOk), epoch(20, beat), epoch(40, beat), ''].join('\n')
    expect(gloveLinks(appRecords(text))[0]).toMatchObject({
      hand: 'right',
      seenAliveMs: 40_000,
      reason: 'log-ended',
    })
  })
})

describe('across overlapping captures', () => {
  const links = (lines, file) => gloveLinks(appRecords(lines.join('\n')), file)

  it('keeps one link per connect, the longest view of it', () => {
    const merged = mergeLinks([
      ...links([time(0, connectOk), time(20, beat), ''], 'short.txt'),
      ...links([time(0, connectOk), time(20, beat), time(40, beat), ''], 'long.txt'),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ file: 'long.txt', seenAliveMs: 40_000 })
  })

  it('counts a record once however many captures it is in', () => {
    const records = appRecords([time(0, connectOk), time(20, beat), ''].join('\n'))
    const tally = tallyRecords(records)
    tallyRecords(records, tally)
    expect(tally.heartbeatMs.right).toEqual([104.5])
  })
})

describe('spread', () => {
  it('summarises durations, and is null for none', () => {
    expect(spread([100, 300, 200, 1000])).toEqual({ n: 4, medianMs: 300, p90Ms: 1000, maxMs: 1000 })
    expect(spread([])).toBeNull()
  })
})
