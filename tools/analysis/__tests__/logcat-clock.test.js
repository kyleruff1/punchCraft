/**
 * The clock of a capture runs on through midnight.
 *
 * A `-v time` line carries a date and a time of day, and every analyzer used
 * the time of day alone — "a capture that crosses midnight is the caller's
 * problem (none of the archived ones do)". Round 1 is four minutes; a suite of
 * whole workouts on an emulator runs for hours, and the first one to cross
 * midnight would have had its events sorted a day apart.
 */

import { recordsWithTag, stitchLogRecords } from '../logcat.mjs'
import { parseLogcat } from '../verify-first-round.mjs'

const NL = String.fromCharCode(10)
const line = (date, time, body) => `${date} ${time} I/ReactNativeJS( 8286): ${body}`
const token = (date, time, ordinal) =>
  line(date, time, `'[INFO] workout.cue.tokenDue', 'ring token fired', { roundIndex: 0, ordinal: ${ordinal} }`)
const clockOf = (text) => stitchLogRecords(text).map((r) => r.ts)

describe('the capture clock', () => {
  it('reads a capture inside one day exactly as before: milliseconds since midnight', () => {
    const text = [token('11-27', '10:00:00.000', 0), token('11-27', '10:00:05.500', 1)].join(NL)
    expect(clockOf(text)).toEqual([36_000_000, 36_005_500])
  })

  it('runs on through midnight', () => {
    const text = [token('11-27', '23:59:59.900', 0), token('11-28', '00:00:00.100', 1), token('11-28', '00:00:04.100', 2)].join(NL)
    const [a, b, c] = clockOf(text)
    expect(b - a).toBe(200)
    expect(c - b).toBe(4_000)
  })

  it('runs on through the end of a month, of February, and of the year', () => {
    for (const [last, first] of [
      ['11-30', '12-01'],
      ['02-28', '03-01'],
      ['02-29', '03-01'],
      ['12-31', '01-01'],
    ]) {
      const [a, b] = clockOf([token(last, '23:59:59.500', 0), token(first, '00:00:00.500', 1)].join(NL))
      expect(b - a).toBe(1_000)
    }
  })

  it('places a line that arrives out of order across midnight where it belongs', () => {
    // Two threads log within the same few milliseconds; the later stamp can
    // be written first.
    const text = [
      token('11-28', '00:00:00.010', 1),
      token('11-27', '23:59:59.990', 0),
      token('11-28', '00:00:00.020', 2),
    ].join(NL)
    const [a, b, c] = clockOf(text)
    expect(b - a).toBe(-20)
    expect(c - b).toBe(30)
  })

  it('does not take a long quiet stretch inside one day for a wrap', () => {
    const [a, b] = clockOf([token('11-27', '01:00:00.000', 0), token('11-27', '15:00:00.000', 1)].join(NL))
    expect(b - a).toBe(14 * 3_600_000)
  })

  it('is the clock every analyzer reads', () => {
    const text = [token('11-27', '23:59:59.900', 0), token('11-28', '00:00:00.100', 1)].join(NL)
    const records = recordsWithTag(text, 'workout.cue.tokenDue')
    expect(records[1].ts - records[0].ts).toBe(200)
  })

  it('gives the correlator the same events whichever side of midnight they fall', () => {
    const capture = (date1, t1, date2, t2) =>
      [
        line(date1, t1, "'[INFO] workout.round.boundary', 'session phase boundary', { transition: 'work-entered',"),
        line(date1, t1, '  roundIndex: 0 }'),
        line(date2, t2, "'[INFO] workout.round.boundary', 'session phase boundary', { transition: 'rest-entered',"),
        line(date2, t2, '  roundIndex: 0 }'),
      ].join(NL)
    const relative = (text) => {
      const events = parseLogcat(text)
      return events.map((e) => [e.type, e.ts - events[0].ts])
    }
    const plain = relative(capture('11-27', '10:00:00.000', '11-27', '10:04:00.000'))
    const across = relative(capture('11-27', '23:58:00.000', '11-28', '00:02:00.000'))
    expect(plain.length).toBeGreaterThan(0)
    expect(plain.at(-1)[1]).toBe(240_000)
    expect(across).toEqual(plain)
  })
})
