/**
 * The intro, the countdown and the rest line: several clips played back to
 * back, found by following the chain from the app's "playing" line. Built
 * here the way a real rest was heard on 2026-11-27: each clip starts in the
 * moment the one before it stopped.
 */
import { ceremoniesOf, ceremonyFindings } from '../ceremonies.mjs'
import { appStopTimes } from '../plays.mjs'
import { playsFrom } from '../sound.mjs'

const HASH = '0123456789abcdef0123456789abcdef'
const line = (code, message, fields, monoMs) => ({
  wallMs: 0,
  monoMs,
  level: 'info',
  args: [`[INFO] ${code}`, message, fields],
})
let nextId = 0
/**
 * A run of clips, each starting where the last stopped. A clip is
 * `[name, lengthMs, how]`; `how.heard: false` is one that makes no sound,
 * `how.stoppedAt` one stopped at that position, `how.open` one still playing.
 */
function chain(startMs, clips) {
  const events = []
  let at = startMs
  for (const [name, durationMs, how = {}] of clips) {
    const id = (nextId += 1)
    const silence = name.startsWith('silence-')
    events.push({
      id,
      type: 'play',
      atMs: at,
      src: `${name}.${HASH}.wav`,
      volume: how.volume ?? 1,
      positionMs: 0,
      durationMs,
    })
    if (!silence && how.heard !== false) {
      events.push({ id, type: 'sound-start', atMs: at + 70 })
      if (!how.open)
        events.push({
          id,
          type: 'sound-end',
          atMs: at + Math.min(durationMs, how.stoppedAt ?? durationMs) - 20,
          peak: 0.4,
        })
    }
    if (how.open) break
    const stoppedAt = how.stoppedAt ?? durationMs
    events.push({ id, type: 'pause', atMs: at + stoppedAt, positionMs: stoppedAt, durationMs })
    if (stoppedAt < durationMs) break
    at += durationMs
  }
  return events
}
const COUNTDOWN = [
  ['warn-opener-15', 2_645],
  ['silence-350', 350],
  ['li-ee8fb1f3', 8_192],
  ['silence-350', 350],
  ['warn-round-2', 5_419],
]
const countdownLines = (at, tracks = 5) => [
  line(
    'workout.warn',
    'round warning prepared',
    { round: 2, tracks, plannedMs: 16_956 },
    at - 40_000,
  ),
  line('workout.warn', 'round warning playing', { round: 2, playId: 'warn-3' }, at),
]
const found = (records, events) =>
  ceremoniesOf(records, playsFrom(events), {
    claimed: new Set(),
    appStops: appStopTimes(records),
    truncationMs: 150,
  })

describe('ceremoniesOf', () => {
  it('follows a countdown through its five clips, gaps and all', () => {
    const [c] = found(countdownLines(42_603), chain(42_603, COUNTDOWN))
    expect(c).toMatchObject({
      name: 'countdown',
      ordinal: 1,
      expectedTracks: 5,
      outcome: 'complete',
      why: null,
    })
    expect(c.tracks.map((t) => `${t.name}:${t.kind}:${t.stop}`)).toEqual([
      'warn-opener-15:countdown:ended',
      'silence-350:silence:ended',
      'li-ee8fb1f3:lead-in:ended',
      'silence-350:silence:ended',
      'warn-round-2:countdown:ended',
    ])
    expect(c.firstSoundMs).toBe(42_673)
    expect(c.lastSoundMs).toBe(42_603 + 16_956 - 20)
  })

  it('finds an intro that opens on a silence, and a rest line of one clip', () => {
    const records = [
      line('workout.intro', 'intro loaded', { tracks: 3 }, 0),
      line('workout.intro', 'intro playing', { playId: 'intro-1' }, 1_000),
      line('workout.recovery', 'recovery loaded', { tracks: 1 }, 90_000),
      line('workout.recovery', 'recovery playing', { playId: 'recovery-2' }, 91_108),
    ]
    const events = [
      ...chain(1_001, [
        ['silence-350', 350],
        ['intro-hello', 5_469],
        ['li-8bf49aaa', 1_520],
      ]),
      ...chain(91_108, [['rr-3658e672', 12_843]]),
    ]
    expect(
      found(records, events).map(
        (c) => `${c.name} ${c.tracks.length}/${c.expectedTracks} ${c.outcome}`,
      ),
    ).toEqual(['intro 3/3 complete', 'rest-line 1/1 complete'])
  })

  it('knows a countdown the app stopped itself from one that broke', () => {
    const cut = chain(42_603, [
      COUNTDOWN[0],
      COUNTDOWN[1],
      ['li-ee8fb1f3', 8_192, { stoppedAt: 3_000 }],
    ])
    const stopAt = cut.at(-1).atMs
    const said = [
      ...countdownLines(42_603),
      line('workout.warn', 'round warning stopped', { wasPlaying: true }, stopAt + 4),
    ]
    expect(found(said, cut)[0]).toMatchObject({ outcome: 'app-stopped', why: null })
    expect(found(countdownLines(42_603), cut)[0]).toMatchObject({
      outcome: 'broken',
      why: 'its clip li-ee8fb1f3 was stopped 5192 ms before its end, and the log does not say why',
    })
  })

  it('calls it broken when a clip ended and nothing followed', () => {
    const [c] = found(countdownLines(42_603), chain(42_603, COUNTDOWN.slice(0, 3)))
    expect(c).toMatchObject({
      outcome: 'broken',
      why: '3 of its 5 clips played: nothing followed li-ee8fb1f3',
    })
  })

  it('calls it broken when a clip played through and made no sound — unless it was at volume 0', () => {
    const silent = (volume) =>
      chain(42_603, [['warn-opener-15', 2_645, { heard: false, volume }], ...COUNTDOWN.slice(1)])
    expect(found(countdownLines(42_603), silent(1))[0].why).toBe(
      'its clip warn-opener-15 was played and made no sound',
    )
    expect(found(countdownLines(42_603), silent(0))[0].outcome).toBe('complete')
  })

  it('does not judge one still playing when the run ended', () => {
    const [c] = found(
      countdownLines(42_603),
      chain(42_603, [COUNTDOWN[0], COUNTDOWN[1], ['li-ee8fb1f3', 8_192, { open: true }]]),
    )
    expect(c).toMatchObject({ outcome: 'run-ended', lastSoundMs: null })
  })

  it('says so when the app started one and no audio element answered', () => {
    expect(found(countdownLines(42_603), [])[0]).toMatchObject({ outcome: 'broken', tracks: [] })
  })

  it('leaves alone what is already spoken for, and the element that never had a source', () => {
    const events = [{ id: 900, type: 'play', atMs: 42_603, src: '' }, ...chain(42_604, COUNTDOWN)]
    const plays = playsFrom(events)
    const claimed = new Set()
    const [c] = ceremoniesOf(countdownLines(42_603), plays, {
      claimed,
      appStops: [],
      truncationMs: 150,
    })
    expect(c.tracks).toHaveLength(5)
    expect(claimed.size).toBe(5)
    // A second pass finds nothing left to claim.
    expect(
      ceremoniesOf(countdownLines(42_603), plays, { claimed, appStops: [], truncationMs: 150 })[0]
        .tracks,
    ).toEqual([])
  })
})

describe('ceremonyFindings', () => {
  const bell = (atMs, firstSoundMs) => ({
    transition: 'work-entered',
    roundIndex: 1,
    atMs,
    bell: { firstSoundMs },
  })
  const findings = (records, events, boundaries = []) =>
    ceremonyFindings(found(records, events), boundaries, 150)

  it('reports the gap from a countdown’s last word to its bell', () => {
    // Last word ends at 59 539; the bell's first sound is at 59 920.
    const f = findings(countdownLines(42_603), chain(42_603, COUNTDOWN), [bell(59_860, 59_920)])
    expect(f.found).toEqual({ countdown: 1 })
    expect(f.countdownToBellMs).toEqual([381])
    expect(f).toMatchObject({ broken: [], cutByApp: [], talkedOver: [], mixedVolumes: [] })
  })

  it('says when the bell cut the countdown, and by how much', () => {
    const cut = chain(42_603, [
      ...COUNTDOWN.slice(0, 4),
      ['warn-round-2', 5_419, { stoppedAt: 4_000 }],
    ])
    const records = [
      ...countdownLines(42_603),
      line('workout.warn', 'round warning stopped', {}, cut.at(-1).atMs + 3),
    ]
    expect(findings(records, cut).cutByApp).toEqual([
      { name: 'countdown', ordinal: 1, label: 'countdown 1', unplayedMs: 1_419, clipsUnreached: 0 },
    ])
  })

  it('says when the app stopped one before some of its clips had started', () => {
    const cut = chain(42_603, [COUNTDOWN[0], ['silence-350', 350, { stoppedAt: 100 }]])
    const records = [
      ...countdownLines(42_603),
      line('workout.warn', 'round warning stopped', {}, cut.at(-1).atMs),
    ]
    expect(findings(records, cut).cutByApp).toEqual([
      expect.objectContaining({ unplayedMs: 0, clipsUnreached: 3 }),
    ])
  })

  it('does not call it cut when the app stops one that had nothing left to say', () => {
    const done = chain(42_603, [
      ...COUNTDOWN.slice(0, 4),
      ['warn-round-2', 5_419, { stoppedAt: 5_300 }],
    ])
    const records = [
      ...countdownLines(42_603),
      line('workout.warn', 'round warning stopped', {}, done.at(-1).atMs),
    ]
    expect(findings(records, done).cutByApp).toEqual([])
  })

  it('says when the rest line was still sounding as the countdown began', () => {
    const records = [
      line('workout.recovery', 'recovery loaded', { tracks: 1 }, 30_000),
      line('workout.recovery', 'recovery playing', {}, 31_108),
      ...countdownLines(42_603),
    ]
    const events = [...chain(31_108, [['rr-3658e672', 12_843]]), ...chain(42_603, COUNTDOWN)]
    // The rest line's last sound is at 43 931; the countdown's first at 42 673.
    expect(findings(records, events).talkedOver).toEqual([
      { label: 'countdown 1', overlapMs: 1_258 },
    ])
  })

  it('says when one ceremony played its clips at different volumes', () => {
    const quietThenLoud = chain(42_603, [
      ['warn-opener-15', 2_645, { volume: 0.6 }],
      ...COUNTDOWN.slice(1),
    ])
    expect(findings(countdownLines(42_603), quietThenLoud).mixedVolumes).toEqual([
      { label: 'countdown 1', volumes: [0.6, 1] },
    ])
  })

  it('names what broke', () => {
    expect(findings(countdownLines(42_603), chain(42_603, COUNTDOWN.slice(0, 3))).broken).toEqual([
      {
        name: 'countdown',
        ordinal: 1,
        label: 'countdown 1',
        why: '3 of its 5 clips played: nothing followed li-ee8fb1f3',
      },
    ])
  })
})

describe('a clip the browser could not play', () => {
  // What a suspended audio file did until the PC server learnt to answer a
  // Range request: asked to play, it reported an error and sat at zero until
  // the bell tore it down fourteen seconds later.
  const ERROR = '2: PipelineStatus::PIPELINE_ERROR_READ: FFmpegDemuxer: data source error'
  const stalled = [
    ...chain(42_603, [COUNTDOWN[0]]),
    {
      id: 777,
      type: 'play',
      atMs: 45_248,
      src: `silence-350.${HASH}.wav`,
      volume: 1,
      positionMs: 0,
      durationMs: 350,
    },
    {
      id: 777,
      type: 'error',
      atMs: 45_252,
      positionMs: 0,
      readyState: 4,
      networkState: 1,
      error: ERROR,
    },
    { id: 777, type: 'emptied', atMs: 59_969, positionMs: 0, durationMs: null },
  ]
  const records = [
    ...countdownLines(42_603),
    line('workout.warn', 'round warning stopped', {}, 59_965),
  ]

  it('is a broken ceremony, in the browser’s own words — not “the bell cut the countdown”', () => {
    const [c] = found(records, stalled)
    expect(c.tracks.map((t) => t.stop)).toEqual(['ended', 'failed'])
    expect(c).toMatchObject({
      outcome: 'broken',
      why: `its clip silence-350 could not be played — the browser reported ${ERROR}`,
    })
    expect(ceremonyFindings([c], [], 150)).toMatchObject({
      broken: [expect.objectContaining({ label: 'countdown 1' })],
      cutByApp: [],
    })
  })
})
