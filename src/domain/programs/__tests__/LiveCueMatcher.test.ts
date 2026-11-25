// ENGINE-BEHAVIOR SUITE — pinned to the FROZEN pre-click-track samples
// (samples/__fixtures__), NOT the live library. The live sets were
// rewritten to the 4-slot click-track format (MVP v2, GH #305) and no
// longer exercise bursts / count scoring / defense-counters; these
// assertions encode engine semantics those shapes exist to test.
/**
 * Live cue matching (#188).
 *
 * The interesting cases are the ones where provisional and settled
 * disagree, because that is the whole reason this adapter exists. A
 * recovered event arriving late can reorder a cue after the athlete has
 * already seen feedback, and the design commitment is that the settled
 * result wins *and says so* rather than quietly rewriting history.
 */
import { LiveCueMatcher, type LiveMatcherEvent } from '../LiveCueMatcher'
import { expandTimeline, type CueInstance } from '../CueTimeline'
import { CADENCE_PROFILES } from '../../workout/cadence'
import { legacyThreeRoundFundamentals as threeRoundFundamentals } from '../../workout/samples/__fixtures__'
import type { CueEvent } from '../CueState'
import type { ExtraPunchPolicy } from '../../workout/WorkoutRecipe'
import type { TrackerPunchEvent } from '../../punch/PunchEvent'

const STEADY_BPM = CADENCE_PROFILES.steady.nominalBpm
const CUE: CueInstance = expandTimeline(threeRoundFundamentals, 'orthodox', STEADY_BPM)[0]!
  .cues[1]!

/**
 * How long the app had been running when the bell rang — the gap between the
 * monotonic clock a punch is stamped on and the work clock a cue is written
 * on. These fixtures used to stamp punches with `CUE.scheduledStartMs`, which
 * made the two clocks one number line and hid every place they were confused.
 */
const UPTIME_AT_BELL_MS = 3_600_000

/** A punch and where it landed on the round's work clock. */
interface Landed {
  event: TrackerPunchEvent
  atMs: number
}

type LandedOverrides = Partial<TrackerPunchEvent> & { atMs?: number }

let nextId = 0

function event(over: LandedOverrides = {}): Landed {
  nextId += 1
  const { atMs = CUE.scheduledStartMs, ...eventOver } = over
  return {
    atMs,
    event: {
      id: `e${nextId}`,
      sourceFrameId: `f${nextId}`,
      deviceId: 'D7:34',
      hand: 'left',
      receivedMonotonicTimeMs: UPTIME_AT_BELL_MS + atMs,
      receivedWallTimeIso: '2026-08-23T00:00:00.000Z',
      recovered: false,
      decoderId: 'fightcamp-v1',
      decoderVersion: '1',
      velocityUnit: 'tracker-unit',
      velocityRaw: 10,
      qualityFlags: [],
      ...eventOver,
    },
  }
}

/** When the nth expected token is scheduled, on the work clock. */
const tokenMs = (n: number, cue: CueInstance = CUE): number =>
  cue.scheduledStartMs + (cue.tokenOffsetsMs[cue.expectedPunches[n]!.tokenIndex] ?? 0)

function onToken(n: number, over: LandedOverrides = {}): Landed {
  const expected = CUE.expectedPunches[n]!
  return event({ hand: expected.hand, atMs: tokenMs(n), ...over })
}

/** Deliver a punch the way the runner does: the event plus its work-clock time. */
const land = (matcher: LiveCueMatcher, punch: Landed): void => {
  matcher.onPunchEvent(punch.event, punch.atMs)
}

/** A real tracker timestamp: device epoch ms, nowhere near either other clock. */
const DEVICE_EPOCH_MS = 1_790_000_000_000

/** Minimal CueEngine events — only the two the matcher listens for. */
const windowOpened = (): CueEvent =>
  ({ type: 'cue-window-opened', cue: CUE, status: 'active', timestamps: {} as never, workElapsedMs: 0, nowMs: 0 })
const windowClosed = (): CueEvent =>
  ({ type: 'cue-window-closed', cue: CUE, status: 'accepting', timestamps: {} as never, workElapsedMs: 0, nowMs: 0 })
const cueCancelled = (): CueEvent =>
  ({ type: 'cue-cancelled', cue: CUE, status: 'cancelled', timestamps: {} as never, workElapsedMs: 0, nowMs: 0 })

function harness(policy: ExtraPunchPolicy = 'neutral') {
  const matcher = new LiveCueMatcher({ tier: 'hand-timestamp', extraPunchPolicy: policy })
  const events: LiveMatcherEvent[] = []
  matcher.subscribe((e) => events.push(e))
  return {
    matcher,
    events,
    matches: () => events.flatMap((e) => (e.type === 'match' ? [e.match] : [])),
    extras: () => events.flatMap((e) => (e.type === 'extra' ? [e.extra] : [])),
    settled: () => events.flatMap((e) => (e.type === 'cue-settled' ? [e] : [])),
  }
}

beforeEach(() => {
  nextId = 0
})

// ---------------------------------------------------------------------------

describe('provisional feedback (doc §21)', () => {
  it('credits a punch the moment it lands, before the window closes', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0))

    // No window-closed yet: the token must already have brightened.
    expect(h.matches()).toHaveLength(1)
    expect(h.matches()[0]).toMatchObject({ cueId: CUE.id, expectedIndex: 0, outcome: 'matched' })
    expect(h.settled()).toHaveLength(0)
  })

  it('fills expectations in order', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0))
    land(h.matcher, onToken(1))
    expect(h.matches().map((m) => m.expectedIndex)).toEqual([0, 1])
  })

  it('reports a wrong hand as an extra without discarding it, leaving the slot open', () => {
    // Since D18 a wrong glove does not consume the ordinal: it is reported as
    // an extra carrying its reason, and the correct hand can still answer.
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, event({ hand: 'right' }))
    expect(h.matches()).toHaveLength(0)
    expect(h.extras()).toHaveLength(1)
    expect(h.extras()[0]?.reason).toBe('hand-mismatch')

    land(h.matcher, onToken(0))
    expect(h.matches()[0]?.expectedIndex).toBe(0)
    expect(h.matches()[0]?.outcome).toBe('matched')
  })

  it('carries tracker-reported velocity through when the source has it', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0, { velocityRaw: 13 }))
    expect(h.matches()[0]?.velocityRaw).toBe(13)
  })

  it('omits velocity when the unit is unknown rather than reporting a bare number', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0, { velocityUnit: 'unknown', velocityRaw: 13 }))
    expect(h.matches()[0]?.velocityRaw).toBeUndefined()
  })

  it('never credits a recovered event, live or settled', () => {
    // Drained after a reconnect: thrown 22-66 s ago, and nothing says when in
    // the round. It may not brighten a token now, and it may not take a slot
    // when the window closes either.
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    const drained = onToken(0, { recovered: true, trackerTimestampMs: DEVICE_EPOCH_MS })
    land(h.matcher, drained)
    expect(h.matches()).toHaveLength(0)

    h.matcher.onCueEvent(windowClosed())
    const settled = h.settled()[0]!
    expect(settled.result.assignments).toEqual([])
    expect(settled.result.missedExpectedIndexes).toEqual([0, 1])
    // Still accounted for — an extra, never dropped.
    expect(settled.result.extras.map((e) => e.eventId)).toEqual([drained.event.id])
  })
})

describe('time bases', () => {
  it('reports the signed offset from the token, measured on the work clock', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0, { atMs: tokenMs(0) - 60 }))
    land(h.matcher, onToken(1, { atMs: tokenMs(1) + 90 }))
    expect(h.matches().map((m) => m.offsetMs)).toEqual([-60, 90])
  })

  it('reports the same offset at any app uptime', () => {
    for (const uptimeMs of [0, 3_600_000, 86_400_000]) {
      const h = harness()
      h.matcher.onCueEvent(windowOpened())
      land(h.matcher, onToken(0, { atMs: tokenMs(0) + 25, receivedMonotonicTimeMs: uptimeMs }))
      expect(h.matches()[0]?.offsetMs).toBe(25)
    }
  })

  it('publishes the monotonic receive stamp as eventTimeMs, never round time', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    const punch = onToken(0)
    land(h.matcher, punch)
    expect(h.matches()[0]?.eventTimeMs).toBe(punch.event.receivedMonotonicTimeMs)
    expect(h.matches()[0]?.eventTimeMs).toBe(UPTIME_AT_BELL_MS + tokenMs(0))
  })

  it('gives the live match the offset the settled result will carry', () => {
    // The on-beat reward is gated on the live offset and the score on the
    // settled one. Two numbers for one punch is how they came to disagree.
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0, { atMs: tokenMs(0) + 110 }))
    land(h.matcher, onToken(1, { atMs: tokenMs(1) - 35 }))
    h.matcher.onCueEvent(windowClosed())

    const settled = h.settled()[0]!
    for (const match of h.matches()) {
      const assignment = settled.result.assignments.find((a) => a.eventId === match.eventId)
      expect(assignment?.offsetMs).toBe(match.offsetMs)
    }
    expect(settled.score.timingWindowPct).toBe(100)
  })
})

describe('extras are always emitted (spec §13.6)', () => {
  it('emits a punch thrown between combinations', () => {
    const h = harness()
    land(h.matcher, event())
    expect(h.extras()).toHaveLength(1)
    expect(h.extras()[0]?.cueId).toBeUndefined()
  })

  it('emits a punch beyond the last expectation, attributed to the open cue', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0))
    land(h.matcher, onToken(1))
    const surplus = onToken(1, { atMs: CUE.scheduledStartMs + 120 })
    land(h.matcher, surplus)

    expect(h.extras()).toHaveLength(1)
    expect(h.extras()[0]).toMatchObject({ cueId: CUE.id, eventId: surplus.event.id })
  })

  it('credits a punch thrown late in the set, since timing no longer gates (D18)', () => {
    // This asserted the opposite until D18: credit was gated on the punch
    // landing inside the acceptance window, so a combination worked slightly
    // late scored as missed while the athlete was still throwing it. Credit is
    // now presence — the set is on screen, so the punch counts.
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0, { atMs: CUE.windowEndMs + 200 }))
    expect(h.matches()).toHaveLength(1)
    expect(h.extras()).toHaveLength(0)
  })

  it('still emits an extra once every expectation is answered', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0))
    land(h.matcher, onToken(1))
    land(h.matcher, onToken(0))
    expect(h.matches()).toHaveLength(2)
    expect(h.extras()).toHaveLength(1)
  })

  it.each(['encouraged', 'neutral', 'discouraged'] as const)(
    'carries the %s policy so the surface can present it',
    (policy) => {
      const h = harness(policy)
      land(h.matcher, event())
      expect(h.extras()[0]?.policy).toBe(policy)
    },
  )

  it('never withholds an extra under any policy', () => {
    // The policy changes presentation, never whether the punch is reported.
    for (const policy of ['encouraged', 'neutral', 'discouraged'] as const) {
      const h = harness(policy)
      land(h.matcher, event())
      expect(h.extras()).toHaveLength(1)
    }
  })
})

describe('settling on window close', () => {
  it('emits the authoritative result and its score', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0))
    land(h.matcher, onToken(1))
    h.matcher.onCueEvent(windowClosed())

    const settled = h.settled()[0]!
    expect(settled.result.cueId).toBe(CUE.id)
    expect(settled.result.assignments).toHaveLength(2)
    expect(settled.score.completionPct).toBe(100)
    expect(settled.score.label).toBe('hand-sequence match')
  })

  it('reports no corrections when provisional and settled agree', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0))
    land(h.matcher, onToken(1))
    h.matcher.onCueEvent(windowClosed())
    expect(h.settled()[0]?.corrections).toEqual([])
  })

  it('does not let a drained punch take the slot a live one left open', () => {
    // The mid-round buffer drain. One live punch answers slot 0; then a punch
    // thrown a minute earlier with the other glove is delivered into the open
    // window. It used to reach the settled pass as though it had just landed —
    // its device-epoch timestamp read as round time, the window test skipped
    // under `gate: 'open'` — and fill slot 1.
    const h = harness()
    h.matcher.onCueEvent(windowOpened())

    const live = onToken(0)
    land(h.matcher, live)
    const drained = onToken(1, { recovered: true, trackerTimestampMs: DEVICE_EPOCH_MS })
    land(h.matcher, drained)
    h.matcher.onCueEvent(windowClosed())

    const settled = h.settled()[0]!
    expect(settled.result.assignments.map((a) => a.eventId)).toEqual([live.event.id])
    expect(settled.result.missedExpectedIndexes).toEqual([1])
    expect(settled.result.extras.map((e) => e.eventId)).toEqual([drained.event.id])
    // Provisional and settled agree, so nothing is reported as corrected.
    expect(settled.corrections).toEqual([])
  })

  it('accumulates settled results for persistence', () => {
    const h = harness()
    for (let i = 0; i < 3; i++) {
      h.matcher.onCueEvent(windowOpened())
      land(h.matcher, onToken(0))
      h.matcher.onCueEvent(windowClosed())
    }
    expect(h.matcher.results()).toHaveLength(3)
  })

  it('settles an empty cue as fully missed rather than skipping it', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    h.matcher.onCueEvent(windowClosed())
    const settled = h.settled()[0]!
    expect(settled.result.missedExpectedIndexes).toEqual([0, 1])
    expect(settled.score.completionPct).toBe(0)
  })
})

describe('a cancelled cue is not graded (doc §25)', () => {
  it('settles nothing when the cue is cancelled', () => {
    // The athlete was told to stop, so there is nothing to grade.
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    land(h.matcher, onToken(0))
    h.matcher.onCueEvent(cueCancelled())

    expect(h.settled()).toHaveLength(0)
    expect(h.matcher.results()).toHaveLength(0)
  })

  it('treats a later punch as an unattributed extra', () => {
    const h = harness()
    h.matcher.onCueEvent(windowOpened())
    h.matcher.onCueEvent(cueCancelled())
    land(h.matcher, event())
    expect(h.extras()[0]?.cueId).toBeUndefined()
  })
})

describe('display-only tokens never enter scoring (D4)', () => {
  it('scores only the punch expectations of a defense-counter cue', () => {
    const defenseCue = expandTimeline(threeRoundFundamentals, 'orthodox', STEADY_BPM)[0]!.cues.find(
      (c) => c.displayOnlyTokenIndexes.length > 0,
    )!
    // The cue has more tokens than expectations: the slip is shown, never
    // scored, and never auto-failed.
    expect(defenseCue.tokens.length).toBeGreaterThan(defenseCue.expectedPunches.length)

    const h = harness()
    h.matcher.onCueEvent({ ...windowOpened(), cue: defenseCue } as CueEvent)
    h.matcher.onCueEvent({ ...windowClosed(), cue: defenseCue } as CueEvent)

    const settled = h.settled()[0]!
    expect(settled.score.expectedCount).toBe(defenseCue.expectedPunches.length)
  })
})

describe('unsubscribe', () => {
  it('stops delivering events', () => {
    const matcher = new LiveCueMatcher({ tier: 'hand-timestamp', extraPunchPolicy: 'neutral' })
    const seen: LiveMatcherEvent[] = []
    const off = matcher.subscribe((e) => seen.push(e))
    land(matcher, event())
    expect(seen).toHaveLength(1)

    off()
    land(matcher, event())
    expect(seen).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Overlapping acceptance windows (2026-08-31 token-order forensics).
//
// Consecutive cues overlap by DEFAULT_GRACE_BEFORE_MS (200 ms):
// `truncateWindowsAtNextCue` ends cue P at `next.scheduledStartMs` while
// cue N's window already opened at `scheduledStartMs - graceBefore`. The
// engine therefore emits opened(N) BEFORE closed(P).
//
// The pre-fix matcher held one unkeyed `open` slot, so opened(N) silently
// discarded P (never settled) and closed(P) then consumed N. Because
// `windowOpened` is latched per runtime, N never re-opened and every later
// punch was published as `extra` — the matcher was orphaned for the rest of
// the round.
// ---------------------------------------------------------------------------

describe('overlapping windows keep cue identity (forensics 2026-08-31)', () => {
  const ROUND = expandTimeline(threeRoundFundamentals, 'orthodox', STEADY_BPM)[0]!
  const CUE_P = ROUND.cues[1]!
  const CUE_N = ROUND.cues.find((c) => c.id !== CUE_P.id)!

  const openedFor = (cue: CueInstance): CueEvent =>
    ({
      type: 'cue-window-opened',
      cue,
      status: 'active',
      timestamps: {} as never,
      workElapsedMs: 0,
      nowMs: 0,
    }) as CueEvent
  const closedFor = (cue: CueInstance): CueEvent =>
    ({
      type: 'cue-window-closed',
      cue,
      status: 'accepting',
      timestamps: {} as never,
      workElapsedMs: 0,
      nowMs: 0,
    }) as CueEvent

  it('settles the outgoing cue when the next window opens over it', () => {
    const h = harness()
    h.matcher.onCueEvent(openedFor(CUE_P))
    // The overlap: N opens while P is still open.
    h.matcher.onCueEvent(openedFor(CUE_N))

    // P must have been settled rather than silently dropped.
    expect(h.settled()).toHaveLength(1)
    expect(h.settled()[0]?.result.cueId).toBe(CUE_P.id)
  })

  it('keeps the newly opened cue live — punches are matched, not orphaned as extras', () => {
    const h = harness()
    h.matcher.onCueEvent(openedFor(CUE_P))
    h.matcher.onCueEvent(openedFor(CUE_N))
    // P's close arrives AFTER N opened — it must not consume N.
    h.matcher.onCueEvent(closedFor(CUE_P))

    // N is still the open cue: a punch belongs to it, not to the extras bin.
    const expected = CUE_N.expectedPunches[0]
    if (!expected) return // defensive: a cue with no punches proves nothing here
    land(h.matcher, event({ hand: expected.hand, atMs: tokenMs(0, CUE_N) }))

    expect(h.matches().map((m) => m.cueId)).toContain(CUE_N.id)
    // Pre-fix this punch was published as an `extra` because `open` was null.
    expect(h.extras()).toHaveLength(0)
  })

  it('a stale close for an already-settled cue does not consume the open one', () => {
    const h = harness()
    h.matcher.onCueEvent(openedFor(CUE_P))
    h.matcher.onCueEvent(openedFor(CUE_N))
    const settledAfterOverlap = h.settled().length
    // Late/duplicate close for P.
    h.matcher.onCueEvent(closedFor(CUE_P))
    // No new settle — N is still open and untouched.
    expect(h.settled()).toHaveLength(settledAfterOverlap)

    // Closing N settles exactly N.
    h.matcher.onCueEvent(closedFor(CUE_N))
    expect(h.settled()).toHaveLength(settledAfterOverlap + 1)
    expect(h.settled().at(-1)?.result.cueId).toBe(CUE_N.id)
  })
})
