/**
 * Parity: does the PC say what the device said? Built here from captures
 * written by the PC's own writer, so each case is a capture the tablet's
 * parser really reads. A capture says which platform wrote it in its QA run
 * record; one that says nothing here is the PC's, by its tag.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { logcatText } from '../capture.mjs'
import {
  changedClips,
  compareSchedules,
  LOST_LINES_ALLOWED,
  parityOf,
  REFERENCE_DIR,
  referenceDevice,
  referenceFrom,
  referenceName,
  referenceRounds,
  renderParity,
  tabletFiguresOf,
} from '../parity.mjs'
import { dispatchKey, scheduleOf } from '../schedule.mjs'

const record = (code, fields) => ({
  wallMs: fields.monotonicTimeMs ?? fields.dispatchMs ?? 0,
  monoMs: 0,
  level: 'info',
  args: [`[INFO] ${code}`, 'message', fields],
})
const WORK = 10_000
const edges = [
  record('workout.round.boundary', {
    transition: 'work-entered',
    roundIndex: 0,
    workElapsedMs: 0,
    monotonicTimeMs: WORK,
  }),
  record('workout.cue.tokenDue', {
    roundIndex: 0,
    workElapsedMs: 4_040,
    monotonicTimeMs: WORK + 4_040,
    scheduledMs: 4_000,
  }),
  record('workout.round.boundary', {
    transition: 'rest-entered',
    roundIndex: 0,
    monotonicTimeMs: WORK + 240_000,
  }),
]
/** A call due at work `at`, sent `lateMs` late; `said: null` leaves its play record out, as a dropped log line would. */
const call = (
  at,
  { slot = 'call/1-2', said = 'One, two!', lateMs = 30, ring = at + 1_400, durationMs = 927 } = {},
) => {
  const traceId = `${slot}#${at}`
  const sentAt = WORK + at + lateMs
  return [
    record('workout.clickScript.dispatch', {
      kind: 'call',
      slot,
      traceId,
      dispatchAtMs: at,
      lateMs,
      durationMs,
      firstNodeMs: ring,
      monotonicTimeMs: sentAt,
    }),
    ...(said === null
      ? []
      : [
          record('workout.voice.play', {
            kind: 'click-script',
            text: said,
            durationMs,
            dispatchMs: sentAt,
            traceId,
          }),
        ]),
  ]
}
const capture = (...calls) =>
  logcatText([...edges.slice(0, 2), ...calls.flat(), edges[2]].sort((a, b) => a.wallMs - b.wallMs))
const three = [
  call(2_600),
  call(6_600),
  call(10_600, { slot: 'call/1-2-3', said: 'One, two, three!' }),
]
const dispatchesOf = (...calls) => scheduleOf(capture(...calls)).dispatches
/** The same capture as a device wrote it: its QA run record names the platform. */
const ranOn = (fields) => record('workout.qa.run', { monotonicTimeMs: 1, ...fields })
const TABLET = { platform: 'android', emulator: false }
const EMULATOR = { platform: 'android', emulator: true }
const deviceCapture = (device, ...calls) =>
  logcatText(
    [ranOn(device), ...edges.slice(0, 2), ...calls.flat(), edges[2]].sort(
      (a, b) => a.wallMs - b.wallMs,
    ),
  )

describe('scheduleOf', () => {
  it('reads round 1 as what was scheduled: clip, words, due time, length, ring', () => {
    const schedule = scheduleOf(capture(...three))
    expect(schedule.dispatches.map(dispatchKey)).toEqual([
      'call call/1-2 @2600 927ms ring@4000 “One, two!”',
      'call call/1-2 @6600 927ms ring@8000 “One, two!”',
      'call call/1-2-3 @10600 927ms ring@12000 “One, two, three!”',
    ])
    expect(schedule.tokensDue).toBe(1)
    expect(schedule.dispatchLateMs).toMatchObject({ n: 3, medianMs: 30 })
    expect(schedule.ringTokenLateMs).toMatchObject({ n: 1, medianMs: 40 })
  })

  it('places a record by its own clock: one sent after the bell belongs to the next round', () => {
    const afterTheBell = call(240_500)
    expect(scheduleOf(capture(...three, afterTheBell)).dispatches).toHaveLength(3)
  })

  it('keeps a dispatch whose play record the log lost, without its words', () => {
    expect(dispatchesOf(call(2_600, { said: null }))[0]).toMatchObject({
      slot: 'call/1-2',
      text: null,
    })
  })

  it('has nothing to say about a capture that never reached a round', () => {
    expect(scheduleOf(logcatText([record('workout.qa.run', { workout: 'x' })]))).toBeNull()
    expect(scheduleOf('')).toBeNull()
  })
})

describe('compareSchedules', () => {
  const pc = dispatchesOf(...three)

  it('finds identical schedules identical', () => {
    expect(compareSchedules(pc, dispatchesOf(...three))).toEqual({
      same: 3,
      differences: [],
      pcOnly: [],
    })
  })

  it('names a dispatch that differs — a different due time, ring, clip or words', () => {
    for (const changed of [
      call(6_700),
      call(6_600, { ring: 8_100 }),
      call(6_600, { slot: 'call/2-3' }),
      call(6_600, { said: 'Jab, cross!' }),
    ]) {
      const result = compareSchedules(pc, dispatchesOf(three[0], changed, three[2]))
      expect(result.same).toBe(2)
      expect(result.differences).toHaveLength(1)
      expect(result.differences[0]).toMatchObject({
        index: 1,
        pc: 'call call/1-2 @6600 927ms ring@8000 “One, two!”',
      })
    }
  })

  it('names what the tablet said that the PC did not', () => {
    const result = compareSchedules(dispatchesOf(three[0], three[2]), pc)
    expect(result.differences.map((d) => d.tablet)).toEqual([
      'call call/1-2 @6600 927ms ring@8000 “One, two!”',
    ])
  })

  it('reads a tablet capture short of a dispatch as the same, with the PC’s extra set aside', () => {
    expect(compareSchedules(pc, dispatchesOf(three[0], three[2]))).toEqual({
      same: 2,
      differences: [],
      pcOnly: ['call call/1-2 @6600 927ms ring@8000 “One, two!”'],
    })
  })

  it('compares a tablet dispatch with no play record without its words', () => {
    const tablet = dispatchesOf(three[0], call(6_600, { said: null }), three[2])
    expect(compareSchedules(pc, tablet)).toEqual({ same: 3, differences: [], pcOnly: [] })
  })
})

describe('changedClips', () => {
  const pc = dispatchesOf(...three)

  it('finds none when both sides play the same recordings', () => {
    expect(changedClips(pc, dispatchesOf(...three))).toEqual([])
  })

  it('names a clip re-recorded shorter, or with other words', () => {
    const longer = dispatchesOf(
      call(2_600, { durationMs: 1_558 }),
      call(6_600, { durationMs: 1_558 }),
      three[2],
    )
    expect(changedClips(pc, longer)).toEqual([
      'call/1-2 was “One, two!”, 1558 ms and is “One, two!”, 927 ms',
    ])
    const reworded = dispatchesOf(
      call(2_600, { said: 'Jab, cross!' }),
      call(6_600, { said: 'Jab, cross!' }),
      three[2],
    )
    expect(changedClips(pc, reworded)).toEqual([
      'call/1-2 was “Jab, cross!”, 927 ms and is “One, two!”, 927 ms',
    ])
  })

  it('does not take a lost play record for a change of words', () => {
    const lost = dispatchesOf(call(2_600, { said: null }), call(6_600, { said: null }), three[2])
    expect(changedClips(pc, lost)).toEqual([])
  })

  it('says nothing of a clip only one side played', () => {
    expect(changedClips(pc, dispatchesOf(three[0]))).toEqual([])
  })
})

describe('parityOf', () => {
  const tabletDrive = {
    workoutId: 'quick-one-two',
    vocab: 'numbers',
    timelineHash: 'v2:aaa',
    verdict: 'WARN',
    stats: 'matched=3',
    build: { gitSha: 'b8e72bc5', sim: 'captured-jam' },
  }
  const referenceOf = (...calls) =>
    referenceFrom({
      logcatText: deviceCapture(TABLET, ...calls),
      drive: tabletDrive,
      source: { suite: 'post-floor', capturedOn: '2026-09-08' },
    })
  const pcRow = {
    workoutId: 'quick-one-two',
    vocab: 'numbers',
    timelineHash: 'v2:aaa',
    sound: null,
  }
  const parity = (pcCalls, reference, row = pcRow) =>
    parityOf({ row, schedule: scheduleOf(capture(...pcCalls)), reference })

  it('builds a reference that says where it came from', () => {
    const reference = referenceOf(...three)
    expect(reference).toMatchObject({
      workoutId: 'quick-one-two',
      timelineHash: 'v2:aaa',
      source: {
        suite: 'post-floor',
        capturedOn: '2026-09-08',
        device: 'tablet',
        build: 'b8e72bc5',
        simulatedPunches: 'captured-jam',
        verdict: 'WARN',
      },
    })
    expect(reference.formatVersion).toBe(2)
    expect(reference.rounds).toHaveLength(1)
    expect(reference.rounds[0].dispatches).toHaveLength(3)
    // The tablet wrote it: there is nothing of the tablet’s to carry beside it.
    expect(reference.tablet).toBeUndefined()
    expect(reference.timing.dispatchLateMs.medianMs).toBe(30)
    expect(referenceFrom({ logcatText: '', drive: tabletDrive, source: {} })).toBeNull()
  })

  it('names its file as the manifests are named', () => {
    expect(referenceName('body-work', 'numbers')).toBe('body-work.json')
    expect(referenceName('body-work', 'techniques')).toBe('body-work.techniques.json')
  })

  it('is SAME when every dispatch matches, and sets the two devices’ lateness side by side', () => {
    const late = [call(2_600, { lateMs: 60 }), call(6_600, { lateMs: 60 }), three[2]]
    const result = parity(late, referenceOf(...three))
    expect(result).toMatchObject({ status: 'SAME', same: 3, of: 3, differenceCount: 0, notes: [] })
    // Lateness differs — and is not what parity is about.
    expect(result.pc.dispatchLateMs.medianMs).toBe(60)
    expect(result.reference).toMatchObject({ device: 'tablet', dispatchLateMs: { medianMs: 30 } })
    // The tablet wrote the reference: its figures are the reference’s, said once.
    expect(result.tablet).toBeNull()
    expect(result.rounds).toEqual({ compared: 1, reference: 1, pc: 1 })
  })

  it('DIFFERS when a dispatch does, and says which', () => {
    const result = parity([three[0], call(6_700), three[2]], referenceOf(...three))
    expect(result.status).toBe('DIFFERS')
    expect(result.differences[0].tablet).toBe('call call/1-2 @6600 927ms ring@8000 “One, two!”')
  })

  it('allows the tablet’s log to have lost a line or two, and says that it read it so', () => {
    const result = parity(three, referenceOf(three[0], three[2]))
    expect(result.status).toBe('SAME')
    expect(result.pcOnlyCount).toBe(1)
    expect(result.notes[0]).toMatch(
      /the PC holds 1 dispatch\(es\) the tablet’s capture does not — read as lines its log lost/,
    )
  })

  it('does not allow more than that: the PC saying much the tablet did not is a difference', () => {
    const many = [
      three[0],
      ...Array.from({ length: LOST_LINES_ALLOWED + 1 }, (_, i) => call(20_000 + i * 4_000)),
    ]
    const result = parity(many, referenceOf(three[0]))
    expect(result.status).toBe('DIFFERS')
    expect(result.notes[0]).toMatch(/too many to be lost log lines/)
  })

  it('skips a workout whose clips were re-recorded since the tablet capture, and says which', () => {
    // The same ring, the same words — a shorter recording, so it is sent later.
    const then = [call(2_071, { durationMs: 1_558, ring: 4_000 }), three[2]]
    const now = [call(2_600, { durationMs: 927, ring: 4_000 }), three[2]]
    const result = parity(now, referenceOf(...then))
    expect(result.status).toBe('SKIPPED')
    expect(result.notes[0]).toMatch(/1 clip\(s\) have been re-recorded since the tablet capture/)
    expect(result.notes[0]).toMatch(/call\/1-2 was “One, two!”, 1558 ms and is “One, two!”, 927 ms/)
  })

  it('skips, without failing, what it cannot compare', () => {
    expect(parity(three, null)).toMatchObject({
      status: 'SKIPPED',
      notes: ['no device capture of this workout to compare with'],
    })
    const moved = parity(three, referenceOf(...three), { ...pcRow, timelineHash: 'v2:bbb' })
    expect(moved.status).toBe('SKIPPED')
    expect(moved.notes[0]).toMatch(
      /timeline has changed since the tablet capture \(v2:aaa then, v2:bbb now\)/,
    )
    expect(parityOf({ row: pcRow, schedule: null, reference: referenceOf(...three) }).status).toBe(
      'SKIPPED',
    )
  })

  it('reads as a page a person can scan', () => {
    const rows = [
      parity(three, referenceOf(...three)),
      parity([three[0], call(6_700), three[2]], referenceOf(...three)),
      parity(three, null),
    ]
    const md = renderParity(rows, { run: 'all22' })
    expect(md).toContain('**1 the same · 1 differ · 1 skipped**')
    // Each lateness figure under the name of the device it is from.
    expect(md).toContain(
      '| quick-one-two | numbers | yes — 3 of 3 | 1 of 1 | 30 / 30 | 30 / 30 (tablet) | — | 40 / 40 | 40 / 40 (tablet) | — | tablet, 2026-09-08, build b8e72bc5 |',
    )
    // The PC's changed dispatch is both things: not what the tablet said, and
    // something the tablet did not say.
    expect(md).toContain('**NO — 1 differ, 1 only on the PC**')
    expect(md).toContain('2026-09-08, build b8e72bc5')
    expect(md).toContain('## What differs')
    expect(md).toContain('no device capture of this workout to compare with')
    expect(md).toMatch(/Nothing on the tablet is tuned from either/)
    expect(md).toContain('round 1, #2 PC: ')
  })
})

/** A second round, 300 s after the first began, and what closes it. */
const ROUND_2 = WORK + 300_000
const round2 = (closing, ...calls) => [
  record('workout.round.boundary', {
    transition: 'work-entered',
    roundIndex: 1,
    workElapsedMs: 0,
    monotonicTimeMs: ROUND_2,
  }),
  record('workout.cue.tokenDue', {
    roundIndex: 1,
    workElapsedMs: 4_020,
    monotonicTimeMs: ROUND_2 + 4_020,
    scheduledMs: 4_000,
  }),
  ...calls.flat(),
  ...(closing === null
    ? []
    : [
        record('workout.round.boundary', {
          transition: closing,
          roundIndex: 1,
          monotonicTimeMs: ROUND_2 + 240_000,
        }),
      ]),
]
/** A call in round 2: the same record, stamped on round 2’s part of the clock. */
const later = (at, options) =>
  call(at, options).map((r) => {
    const fields = { ...r.args[2] }
    if (fields.monotonicTimeMs !== undefined) fields.monotonicTimeMs += 300_000
    if (fields.dispatchMs !== undefined) fields.dispatchMs += 300_000
    return { ...r, wallMs: r.wallMs + 300_000, args: [r.args[0], r.args[1], fields] }
  })
const twoRounds = (device, closing, second = [later(2_600), later(6_600)]) =>
  logcatText(
    [
      ...(device ? [ranOn(device)] : []),
      ...edges,
      ...three.flat(),
      ...round2(closing, ...second),
    ].sort((a, b) => a.wallMs - b.wallMs),
  )

describe('every round of a capture', () => {
  it('reads each round the capture opened, and says which it holds whole', () => {
    const schedule = scheduleOf(twoRounds(null, 'completed'))
    expect(
      schedule.rounds.map((r) => [r.roundIndex, r.whole, r.dispatches.length, r.tokensDue]),
    ).toEqual([
      [0, true, 3, 1],
      [1, true, 2, 1],
    ])
    // Round 1 is still what the top level holds; the lateness is every whole round’s.
    expect(schedule.dispatches).toHaveLength(3)
    expect(schedule.dispatchLateMs.n).toBe(5)
    expect(schedule.ringTokenLateMs).toMatchObject({ n: 2, minMs: 20, maxMs: 40 })
  })

  it('does not call a round whole when the capture ends inside it', () => {
    // The default PC drive stops three seconds into round 2.
    const schedule = scheduleOf(twoRounds(null, null))
    expect(schedule.rounds.map((r) => r.whole)).toEqual([true, false])
    expect(schedule.dispatchLateMs.n).toBe(3)
  })

  it('nor one that was cancelled: it ended, and was not completed', () => {
    expect(scheduleOf(twoRounds(null, 'cancelled')).rounds.map((r) => r.whole)).toEqual([
      true,
      false,
    ])
  })
})

describe('a reference names its device', () => {
  const drive = {
    workoutId: 'quick-one-two',
    vocab: 'numbers',
    timelineHash: 'v2:aaa',
    verdict: 'PASS',
    stats: 'matched=3',
    build: { gitSha: 'aa3a8f83', sim: 'captured-jam' },
  }
  const source = { suite: 'emu-all', capturedOn: '2026-11-28' }
  const tabletReference = referenceFrom({
    logcatText: deviceCapture(TABLET, ...three),
    drive,
    source: { suite: 'post-floor', capturedOn: '2026-09-08' },
  })

  it('by what the capture says wrote it', () => {
    expect(referenceDevice(deviceCapture(TABLET, ...three))).toBe('tablet')
    expect(referenceDevice(deviceCapture(EMULATOR, ...three))).toBe('emulator')
  })

  it('believes the suite’s row over a capture that does not say', () => {
    // An emulator running a build from before the capture said so reads as
    // the tablet. The suite asked the device, and its row knows.
    const silent = deviceCapture(TABLET, ...three)
    expect(referenceDevice(silent, { deviceIsEmulator: true })).toBe('emulator')
    expect(
      referenceDevice(silent, {
        timingRefusal: 'the device is an emulator, and an emulator on this PC is a PC',
      }),
    ).toBe('emulator')
    expect(referenceDevice(silent, { deviceIsEmulator: false, timingRefusal: null })).toBe('tablet')
    // A row cannot make a PC capture a device’s.
    expect(referenceDevice(capture(...three), { deviceIsEmulator: true })).toBeNull()
  })

  it('and refuses a PC capture: the reference is what the PC is compared with', () => {
    expect(referenceDevice(capture(...three))).toBeNull()
    expect(referenceFrom({ logcatText: capture(...three), drive, source })).toBeNull()
  })

  it('holds every round the capture holds whole, and no part of one', () => {
    const whole = referenceFrom({ logcatText: twoRounds(EMULATOR, 'completed'), drive, source })
    expect(whole.rounds.map((r) => [r.roundIndex, r.dispatches.length])).toEqual([
      [0, 3],
      [1, 2],
    ])
    expect(whole.source).toMatchObject({ device: 'emulator', build: 'aa3a8f83' })
    const short = referenceFrom({ logcatText: twoRounds(EMULATOR, null), drive, source })
    expect(short.rounds.map((r) => r.roundIndex)).toEqual([0])
  })

  it('carries the tablet’s own lateness forward when an emulator replaces a tablet capture', () => {
    const fromEmulator = referenceFrom({
      logcatText: twoRounds(EMULATOR, 'completed'),
      drive,
      source,
      previous: tabletReference,
    })
    expect(fromEmulator.tablet).toMatchObject({
      capturedOn: '2026-09-08',
      suite: 'post-floor',
      rounds: 1,
      timing: { dispatchLateMs: { medianMs: 30 } },
    })
    // And again, when that one is itself replaced by another emulator run.
    const again = referenceFrom({
      logcatText: twoRounds(EMULATOR, 'completed'),
      drive,
      source,
      previous: fromEmulator,
    })
    expect(again.tablet).toEqual(fromEmulator.tablet)
  })

  it('carries nothing when there is nothing of the tablet’s to carry, or the tablet wrote it', () => {
    expect(tabletFiguresOf(null)).toBeNull()
    expect(tabletFiguresOf({ source: { device: 'emulator' }, timing: {} })).toBeNull()
    const fromTablet = referenceFrom({
      logcatText: deviceCapture(TABLET, ...three),
      drive,
      source,
      previous: tabletReference,
    })
    expect(fromTablet.tablet).toBeUndefined()
  })

  it('reads a reference from before references held every round', () => {
    const old = { round1: { dispatches: [{ slot: 'call/1-2' }], tokensDue: 193 } }
    expect(referenceRounds(old)).toEqual([
      { roundIndex: 0, dispatches: [{ slot: 'call/1-2' }], tokensDue: 193 },
    ])
  })
})

describe('parity over every round', () => {
  const drive = {
    workoutId: 'quick-one-two',
    vocab: 'numbers',
    timelineHash: 'v2:aaa',
    verdict: 'PASS',
    stats: 'matched=3',
    build: { gitSha: 'aa3a8f83', sim: 'captured-jam' },
  }
  const source = { suite: 'emu-all', capturedOn: '2026-11-28' }
  const row = { workoutId: 'quick-one-two', vocab: 'numbers', timelineHash: 'v2:aaa', sound: null }
  const tabletReference = referenceFrom({
    logcatText: deviceCapture(TABLET, ...three),
    drive,
    source: { suite: 'post-floor', capturedOn: '2026-09-08' },
  })
  const reference = referenceFrom({
    logcatText: twoRounds(EMULATOR, 'completed'),
    drive,
    source,
    previous: tabletReference,
  })
  const against = (pcCapture, ref = reference) =>
    parityOf({ row, schedule: scheduleOf(pcCapture), reference: ref })

  it('compares a whole-workout run on every round the reference holds', () => {
    const result = against(twoRounds(null, 'completed'))
    expect(result).toMatchObject({
      status: 'SAME',
      same: 5,
      of: 5,
      rounds: { compared: 2, reference: 2, pc: 2 },
    })
  })

  it('compares a round-1 run on round 1, and that is not a failure', () => {
    expect(against(twoRounds(null, null))).toMatchObject({
      status: 'SAME',
      same: 3,
      of: 3,
      rounds: { compared: 1, reference: 2, pc: 1 },
    })
  })

  it('finds a difference in round 2, and says which round', () => {
    const result = against(twoRounds(null, 'completed', [later(2_600), later(6_700)]))
    expect(result.status).toBe('DIFFERS')
    expect(result.differences[0]).toMatchObject({ round: 2, index: 1 })
  })

  it('compares what it can with a reference that holds round 1 only', () => {
    const old = { ...tabletReference, rounds: undefined, round1: tabletReference.rounds[0] }
    expect(against(twoRounds(null, 'completed'), old)).toMatchObject({
      status: 'SAME',
      rounds: { compared: 1, reference: 1, pc: 2 },
    })
  })

  it('skips a PC run that completed no round the reference holds', () => {
    const none = logcatText([edges[0], ...three.flat()].sort((a, b) => a.wallMs - b.wallMs))
    expect(against(none)).toMatchObject({
      status: 'SKIPPED',
      notes: ['the PC drive did not complete a round the reference holds'],
    })
  })

  it('sets the emulator’s lateness and the tablet’s side by side, each under its own name', () => {
    const md = renderParity([against(twoRounds(null, 'completed'))], { run: 'full' })
    expect(md).toContain(
      '| yes — 5 of 5 | 2 of 2 | 30 / 30 | 30 / 30 (emulator) | 30 / 30 (2026-09-08) |',
    )
    expect(md).toContain('| emulator, 2026-11-28, build aa3a8f83 |')
    expect(md).toMatch(/An emulator on this PC is a PC/)
  })
})

describe('the committed reference', () => {
  const files = existsSync(REFERENCE_DIR)
    ? readdirSync(REFERENCE_DIR).filter((f) => f.endsWith('.json'))
    : []

  it('is there, and every file reads: a device, and at least one round of dispatches', () => {
    expect(files.length).toBeGreaterThanOrEqual(22)
    for (const name of files) {
      const reference = JSON.parse(readFileSync(path.join(REFERENCE_DIR, name), 'utf8'))
      expect(['tablet', 'emulator']).toContain(reference.source.device)
      const rounds = referenceRounds(reference)
      expect(rounds.length).toBeGreaterThan(0)
      expect(rounds[0].dispatches.length).toBeGreaterThan(0)
    }
  })
})
