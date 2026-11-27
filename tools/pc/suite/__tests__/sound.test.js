/**
 * What the tap heard, joined to what the app says it played. Every number is
 * chosen so the join can be checked by hand: the round's work clock starts at
 * 10 000 on the page's clock, and a call of 1 000 ms that is sent at work
 * 2 600 leads a ring due at work 4 000 — page 14 000.
 */
import {
  clipTimings,
  heardClips,
  playsFrom,
  renderSoundReport,
  soundReport,
  soundVerdict,
} from '../sound.mjs'

const record = (code, fields) => ({
  wallMs: 0,
  monoMs: 0,
  level: 'info',
  args: [`[INFO] ${code}`, 'message', fields],
})
const WORK_STARTS = 10_000
const round = [
  record('workout.round.boundary', {
    transition: 'work-entered',
    roundIndex: 0,
    workElapsedMs: 0,
    monotonicTimeMs: WORK_STARTS,
  }),
  record('workout.cue.tokenDue', {
    roundIndex: 0,
    workElapsedMs: 4_040,
    monotonicTimeMs: WORK_STARTS + 4_040,
    scheduledMs: 4_000,
  }),
  record('workout.cue.tokenDue', {
    roundIndex: 0,
    workElapsedMs: 4_540,
    monotonicTimeMs: WORK_STARTS + 4_540,
    scheduledMs: 4_500,
  }),
]
/** A call sent at work `atWork` (so `lateMs` late), 1 000 ms long, leading a ring 1 400 ms after its due send. */
const call = (
  atWork,
  { lateMs = 40, volume = 1, path = 'armed', kind = 'call', slot = 'call/1-2' } = {},
) => {
  const traceId = `${slot}#${atWork}`
  const sentAt = WORK_STARTS + atWork + lateMs
  return [
    record('workout.clickScript.dispatch', {
      kind,
      slot,
      traceId,
      dispatchAtMs: atWork,
      lateMs,
      durationMs: 1_000,
      firstNodeMs: atWork + 1_400,
      breathMs: 400,
      monotonicTimeMs: sentAt,
    }),
    record('workout.voice.play', {
      kind: 'click-script',
      text: 'One, two!',
      durationMs: 1_000,
      volume,
      path,
      dispatchMs: sentAt,
      traceId,
      playId: `p-${atWork}`,
    }),
  ]
}
/**
 * The tap's events for one play of element `id`: asked at `at`, sounding from
 * +`startAfter` for `heardMs`, and stopping with its playhead at `stoppedAt` —
 * the clip's own end, unless told otherwise.
 */
const played = (
  id,
  at,
  { startAfter = 85, heardMs = 980, durationMs = 1_000, stoppedAt = durationMs } = {},
) => [
  { id, type: 'play', atMs: at, src: 'call.wav', volume: 1, positionMs: 0, durationMs },
  { id, type: 'playing', atMs: at + 3, durationMs },
  ...(heardMs === null
    ? []
    : [
        { id, type: 'sound-start', atMs: at + startAfter },
        { id, type: 'sound-end', atMs: at + startAfter + heardMs, peak: 0.4 },
        {
          id,
          type: 'pause',
          atMs: at + startAfter + heardMs + 40,
          positionMs: stoppedAt,
          durationMs,
        },
      ]),
]
const LIMITS = { floorMs: 150, truncationMs: 150 }
const SENT = WORK_STARTS + 2_600 + 40

describe('playsFrom', () => {
  it('makes one play of each call to play(), with the sound that followed it', () => {
    const [first, second] = playsFrom([...played(1, 1_000), ...played(1, 5_000, { heardMs: 500 })])
    expect(first).toMatchObject({
      id: 1,
      playAtMs: 1_000,
      playingAtMs: 1_003,
      sound: [{ startMs: 1_085, endMs: 2_065, peak: 0.4 }],
    })
    expect(second.sound).toEqual([{ startMs: 5_085, endMs: 5_585, peak: 0.4 }])
  })

  it('keeps each stretch of a clip with pauses in it', () => {
    const events = [
      ...played(1, 1_000, { heardMs: 300 }),
      { id: 1, type: 'sound-start', atMs: 1_600 },
      { id: 1, type: 'sound-end', atMs: 2_000, peak: 0.2 },
    ]
    expect(playsFrom(events)[0].sound.map((s) => [s.startMs, s.endMs])).toEqual([
      [1_085, 1_385],
      [1_600, 2_000],
    ])
  })

  it('hands a stretch still open to the next play of the element, which never fell silent', () => {
    const events = [
      { id: 1, type: 'play', atMs: 1_000 },
      { id: 1, type: 'sound-start', atMs: 1_085 },
      { id: 1, type: 'play', atMs: 1_500 },
      { id: 1, type: 'sound-end', atMs: 2_400, peak: 0.3 },
    ]
    const [first, second] = playsFrom(events)
    expect(first.sound).toEqual([{ startMs: 1_085, endMs: 1_500, peak: null }])
    // No new start was reported — there was no silence to end — but the
    // second play was heard all the same, from the moment it was asked for.
    expect(second.sound).toEqual([{ startMs: 1_500, endMs: 2_400, peak: 0.3 }])
  })

  it('reads events in time order however they arrived, and ignores any before a play', () => {
    const events = [
      { id: 1, type: 'sound-end', atMs: 900, peak: 0.1 },
      ...played(1, 1_000),
    ].reverse()
    expect(playsFrom(events)).toHaveLength(1)
    expect(playsFrom(events)[0].sound).toHaveLength(1)
  })

  it('notes what stopped a play', () => {
    const events = [
      ...played(1, 1_000),
      { id: 1, type: 'pause', atMs: 2_100 },
      { id: 1, type: 'ended', atMs: 2_101 },
    ]
    expect(playsFrom(events)[0]).toMatchObject({ stoppedBy: 'pause', stoppedAtMs: 2_100 })
  })
})

describe('heardClips', () => {
  it('finds the element that played each clip the app logged', () => {
    const [clip] = heardClips([...round, ...call(2_600)], playsFrom(played(7, SENT + 1)))
    expect(clip).toMatchObject({
      playId: 'p-2600',
      element: 7,
      firstSoundMs: SENT + 86,
      lastSoundMs: SENT + 1_066,
      statedMs: 1_000,
    })
  })

  it('prefers the element that sounded: a clip yet to download starts on one element and swaps to another', () => {
    const events = [...played(1, SENT, { heardMs: null, durationMs: null }), ...played(2, SENT + 3)]
    expect(
      heardClips([...round, ...call(2_600, { path: 'fresh' })], playsFrom(events))[0].element,
    ).toBe(2)
  })

  it('does not take a clip of another length that happened to start nearby — a bell, say', () => {
    const bell = played(9, SENT + 2, { durationMs: 2_400 })
    expect(heardClips([...round, ...call(2_600)], playsFrom(bell))[0]).toMatchObject({
      element: null,
      firstSoundMs: null,
    })
  })

  it('does not reach for a play outside the moment of the dispatch', () => {
    expect(
      heardClips([...round, ...call(2_600)], playsFrom(played(7, SENT + 400)))[0].element,
    ).toBeNull()
  })

  it('gives an element’s play to one clip only', () => {
    const records = [...round, ...call(2_600), ...call(2_600, { lateMs: 60 })]
    expect(heardClips(records, playsFrom(played(7, SENT + 1))).map((c) => c.element)).toEqual([
      7,
      null,
    ])
  })

  it('judges only calls and lead-ins — the clips a ring waits on', () => {
    const bell = record('workout.voice.play', {
      kind: 'instruction',
      asset: 'bell',
      dispatchMs: SENT,
    })
    expect(heardClips([bell], playsFrom(played(7, SENT)))).toEqual([])
  })
})

describe('clipTimings', () => {
  const timed = (records, events) => clipTimings(records, heardClips(records, playsFrom(events)))

  it('measures a call’s last sound against the scheduled time of the ring it leads', () => {
    // Sent 40 ms late, sounds 85 ms after that for 980 ms: last sound at
    // page 10 000 + 2 600 + 40 + 1 + 85 + 980 = 13 706. The ring is due at
    // work 4 000 = page 14 000. Gap: 294.
    const [clip] = timed([...round, ...call(2_600)], played(7, SENT + 1))
    expect(clip).toMatchObject({
      kind: 'call',
      slot: 'call/1-2',
      roundIndex: 0,
      intendedBreathMs: 400,
      dispatchLateMs: 40,
    })
    expect(clip.breathMs).toBe(294)
    expect(clip.startAfterDispatchMs).toBe(86)
    expect(clip.startAfterScheduleMs).toBe(126)
    expect(clip.heardMs).toBe(980)
  })

  it('goes by the ring’s schedule, not by when the runner’s loop got round to logging it', () => {
    // Every ring token here was logged 40 ms after its scheduled time. A gap
    // measured to the log would read 40 ms roomier than it was.
    const [clip] = timed([...round, ...call(2_600)], played(7, SENT + 1))
    expect(clip.breathMs).not.toBe(294 + 40)
  })

  it('picks the dispatch of this round when the same call recurs every round', () => {
    const secondRound = [
      record('workout.round.boundary', {
        transition: 'rest-entered',
        roundIndex: 0,
        monotonicTimeMs: 250_000,
      }),
      record('workout.round.boundary', {
        transition: 'work-entered',
        roundIndex: 1,
        workElapsedMs: 0,
        monotonicTimeMs: 310_000,
      }),
      record('workout.cue.tokenDue', {
        roundIndex: 1,
        workElapsedMs: 4_040,
        monotonicTimeMs: 314_040,
        scheduledMs: 4_000,
      }),
      record('workout.clickScript.dispatch', {
        kind: 'call',
        slot: 'call/1-2',
        traceId: 'call/1-2#2600',
        dispatchAtMs: 2_600,
        lateMs: 10,
        durationMs: 1_000,
        firstNodeMs: 4_000,
        breathMs: 400,
        monotonicTimeMs: 312_610,
      }),
      record('workout.voice.play', {
        kind: 'click-script',
        text: 'One, two!',
        durationMs: 1_000,
        volume: 1,
        path: 'armed',
        dispatchMs: 312_610,
        traceId: 'call/1-2#2600',
        playId: 'p-r2',
      }),
    ]
    const clips = timed(
      [...round, ...call(2_600), ...secondRound],
      [...played(7, SENT + 1), ...played(7, 312_611)],
    )
    expect(clips.map((c) => [c.roundIndex, c.dispatchLateMs])).toEqual([
      [0, 40],
      [1, 10],
    ])
    // Round 2's ring is due at page 314 000; its call's last sound was at 313 676.
    expect(clips[1].breathMs).toBe(324)
  })

  it('says nothing it cannot know: a clip with no dispatch record, or one never heard', () => {
    const orphan = record('workout.voice.play', {
      kind: 'click-script',
      text: 'x',
      durationMs: 1_000,
      volume: 1,
      dispatchMs: SENT,
      traceId: 'nowhere#1',
    })
    expect(timed([...round, orphan], played(7, SENT + 1))[0]).toMatchObject({
      kind: null,
      breathMs: null,
      heardMs: 980,
    })
    expect(timed([...round, ...call(2_600)], [])[0]).toMatchObject({
      kind: 'call',
      breathMs: null,
      heardMs: null,
    })
  })
})

describe('soundReport', () => {
  const ready = { type: 'tap-ready', atMs: 1, state: 'running', sampleRate: 48_000 }
  const report = (records, events) =>
    soundReport([...round, ...records], [ready, ...events], LIMITS)

  it('counts a clean drive and gives the gap before the ring', () => {
    const r = report(
      [...call(2_600), ...call(6_600)],
      [...played(7, SENT + 1), ...played(7, SENT + 4_001)],
    )
    expect(r.tap).toMatchObject({ ready: true, sampleRate: 48_000, failures: [] })
    expect(r.clips).toMatchObject({
      played: 2,
      heard: 2,
      ducked: 0,
      unfinished: 0,
      silent: [],
      cutShort: [],
    })
    expect(r.calls).toMatchObject({
      n: 2,
      underFloor: 0,
      pastRing: [],
      floorMs: 150,
      intendedBreathMs: [400],
    })
    expect(r.calls.breath).toMatchObject({ n: 2, minMs: 294, medianMs: 294 })
    expect(r.start.armed.medianMs).toBe(86)
  })

  it('names a clip that was played and made no sound — and why it thinks so', () => {
    const noElement = report(call(2_600), [])
    expect(noElement.clips.silent).toEqual([
      expect.objectContaining({ slot: 'call/1-2', element: null }),
    ])
    const noSound = report(call(2_600), played(7, SENT + 1, { heardMs: null }))
    expect(noSound.clips.silent).toEqual([expect.objectContaining({ element: 7 })])
  })

  it('does not call a ducked clip silent: volume 0 is silence on purpose', () => {
    const r = report(call(2_600, { volume: 0 }), played(7, SENT + 1, { heardMs: null }))
    expect(r.clips).toMatchObject({ played: 1, ducked: 1, silent: [] })
  })

  it('names a clip stopped before its end, past the allowance', () => {
    const cutAt = (stoppedAt) =>
      report(call(2_600), played(7, SENT + 1, { stoppedAt })).clips.cutShort
    expect(cutAt(840)).toEqual([expect.objectContaining({ slot: 'call/1-2', stoppedShortMs: 160 })])
    expect(cutAt(860)).toEqual([])
  })

  it('does not call a clip cut for being heard shorter than its file: a quiet head and tail are not a cut', () => {
    // Played to its end; 200 ms of the file was under the follower's threshold.
    const r = report(call(2_600), played(7, SENT + 1, { heardMs: 800 }))
    expect(r.clips.cutShort).toEqual([])
    expect(r.length.heardMinusStated.minMs).toBe(-200)
  })

  it('counts a clip cut off by its own element being played again', () => {
    const events = [
      ...played(7, SENT + 1, { heardMs: null }),
      { id: 7, type: 'sound-start', atMs: SENT + 86 },
      // Asked to play again 400 ms into the clip, before it had stopped.
      { id: 7, type: 'play', atMs: SENT + 401, positionMs: 400, durationMs: 1_000 },
    ]
    expect(report(call(2_600), events).clips.cutShort).toEqual([
      expect.objectContaining({ stoppedShortMs: 600 }),
    ])
  })

  it('names a call still sounding when its ring was due, and counts those under the floor', () => {
    // Starting 400 ms late: last sound at 14 021, the ring due at 14 000.
    const late = report(call(2_600), played(7, SENT + 1, { startAfter: 400 }))
    expect(late.calls.pastRing).toEqual([expect.objectContaining({ breathMs: -21 })])
    // Starting 250 ms late: 129 ms before the ring — under the floor, not past it.
    const tight = report(call(2_600), played(7, SENT + 1, { startAfter: 250 }))
    expect(tight.calls).toMatchObject({ underFloor: 1, underFloorRatio: 1, pastRing: [] })
  })

  it('does not judge the end of a clip that was still sounding when the capture stopped', () => {
    const events = [
      { id: 7, type: 'play', atMs: SENT + 1, durationMs: 1_000 },
      { id: 7, type: 'sound-start', atMs: SENT + 86 },
    ]
    expect(report(call(2_600), events).clips).toMatchObject({
      unfinished: 1,
      heard: 0,
      silent: [],
      cutShort: [],
    })
  })

  it('judges the gap before a ring for calls only; a lead-in is heard and counted', () => {
    const r = report(call(2_600, { kind: 'lead-in', slot: 'lead-in/x' }), played(7, SENT + 1))
    expect(r.calls.n).toBe(0)
    expect(r.leadIns.n).toBe(1)
  })

  it('counts the other plays it heard — bells, the countdown — without judging them', () => {
    const events = [...played(7, SENT + 1), ...played(8, 20_000, { durationMs: 2_400 })]
    expect(report(call(2_600), events).otherPlays).toBe(1)
  })

  it('says so when the tap never started', () => {
    const r = soundReport(
      [...round, ...call(2_600)],
      [{ type: 'tap-failed', atMs: 1, error: 'no worklet' }],
      LIMITS,
    )
    expect(r.tap).toMatchObject({ ready: false, failures: ['no worklet'] })
    expect(renderSoundReport(r, 'x')).toContain('the sound tap did not start')
  })

  it('reads as a page a person can scan', () => {
    const md = renderSoundReport(
      report(call(2_600), played(7, SENT + 1, { startAfter: 400 })),
      'quick-one-two (numbers)',
    )
    expect(md).toContain('# Sound — quick-one-two (numbers)')
    expect(md).toContain('calls and lead-ins: 1 played · 1 heard · 0 silent · 0 cut short')
    expect(md).toContain('| last sound → its ring due (calls) | 1 | -21 | -21 | -21 | -21 |')
    expect(md).toContain('**still sounding when the ring was due: 1**')
    expect(md).toContain('- call/1-2 · round 1 · “One, two!” — -21 ms')
    expect(md).toContain('no tablet constant is set from them')
  })
})

describe('soundVerdict', () => {
  const ready = { type: 'tap-ready', atMs: 1, state: 'running', sampleRate: 48_000 }
  const verdict = (records, events, floorRatio = 0.02) =>
    soundVerdict(soundReport([...round, ...records], [ready, ...events], LIMITS), { floorRatio })

  it('passes a drive where every clip sounded, whole, and clear of its ring', () => {
    expect(verdict(call(2_600), played(7, SENT + 1))).toEqual({
      verdict: 'PASS',
      hard: [],
      soft: [],
    })
  })

  it('fails on a clip that was played and made no sound', () => {
    const v = verdict(call(2_600), played(7, SENT + 1, { heardMs: null }))
    expect(v.verdict).toBe('FAIL')
    expect(v.hard).toEqual(['1 clip(s) were played and made no sound — first: call/1-2, round 1'])
  })

  it('fails on a clip stopped before its end', () => {
    const v = verdict(call(2_600), played(7, SENT + 1, { heardMs: 300, stoppedAt: 385 }))
    expect(v.hard).toEqual([
      '1 clip(s) were stopped more than 150 ms before their end — first: call/1-2, round 1, 615 ms of its 1000 left unplayed',
    ])
  })

  it('fails on a call still sounding when its ring was due, and names the worst', () => {
    const records = [...call(2_600), ...call(6_600)]
    const events = [
      ...played(7, SENT + 1, { startAfter: 400 }),
      ...played(7, SENT + 4_001, { startAfter: 500 }),
    ]
    const v = verdict(records, events)
    expect(v.verdict).toBe('FAIL')
    expect(v.hard).toEqual([
      '2 call(s) were still sounding when their ring was due — worst: call/1-2, round 1, 121 ms past it',
    ])
  })

  it('warns, and no more, when too many calls stop under the floor', () => {
    const v = verdict(call(2_600), played(7, SENT + 1, { startAfter: 250 }))
    expect(v).toEqual({
      verdict: 'WARN',
      hard: [],
      soft: ['1 of 1 calls (100%) stopped less than 150 ms before their ring — the least 129 ms'],
    })
    // The same drive under a share that allows it.
    expect(verdict(call(2_600), played(7, SENT + 1, { startAfter: 250 }), 1).verdict).toBe('PASS')
  })

  it('does not fail a drive on a broken instrument — and does not pass it either', () => {
    const report = soundReport(
      [...round, ...call(2_600)],
      [{ type: 'tap-failed', atMs: 1, error: 'no worklet' }],
      LIMITS,
    )
    expect(soundVerdict(report, { floorRatio: 0.02 })).toEqual({
      verdict: 'WARN',
      hard: [],
      soft: ['the sound tap did not start, so no clip was listened to'],
    })
    const oneElement = soundReport(
      [...round, ...call(2_600)],
      [
        ready,
        { id: 3, type: 'tap-failed', atMs: 2, error: 'already connected' },
        ...played(7, SENT + 1),
      ],
      LIMITS,
    )
    expect(soundVerdict(oneElement, { floorRatio: 0.02 })).toMatchObject({
      verdict: 'WARN',
      soft: ['the sound tap could not listen to 1 element(s): already connected'],
    })
  })
})
