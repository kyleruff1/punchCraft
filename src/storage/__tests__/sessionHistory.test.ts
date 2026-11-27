/**
 * Saved sessions, read back for the app to show — on real SQLite, written
 * through the same `persistWorkoutSession` the runner uses.
 */
import { createMigratedDb } from './helpers/memoryDb'
import { persistWorkoutSession } from '../persistWorkoutSession'
import { SessionRepository } from '../repositories/SessionRepository'
import { WorkoutRepository, type CueResultRow } from '../repositories/WorkoutRepository'
import {
  BUILT_WORKOUT_TITLE,
  listSessionHistory,
  readSessionSummary,
  workoutTitle,
} from '../sessionHistory'
import { SIM_DECODER_ID } from '@simulation/SimulatedPunchSource'
import { threeRoundFundamentals } from '@domain/workout/samples'
import type { LiveCounts } from '@domain/programs/liveCounts'
import type { TrackerPunchEvent } from '@domain/punch/PunchEvent'

const WORKOUT = threeRoundFundamentals
const blockOf = (round: number): string => WORKOUT.schedule[round]!.blocks[0]!.id

type PendingCueResult = Omit<CueResultRow, 'sessionId' | 'generatedWorkoutId'>
const cueRow = (over: Partial<PendingCueResult> = {}): PendingCueResult => ({
  blockId: blockOf(0),
  repeatIndex: 0,
  tokenIndex: 0,
  expectedHand: 'left',
  expectedType: null,
  observedEventId: null,
  outcome: 'matched',
  offsetMs: 12,
  velocityRaw: 10,
  velocityCalibrated: null,
  velocityUnit: 'tracker-unit',
  capabilityTier: 'hand-timestamp',
  decoderVersion: '1.0.0',
  calculationVersion: '1.1.0',
  ...over,
})

/** Rounds 0 and 1 ran; four punches were called, three landed. */
const CUES: PendingCueResult[] = [
  cueRow({ tokenIndex: 0 }),
  cueRow({ tokenIndex: 1, expectedHand: 'right' }),
  cueRow({ blockId: blockOf(1), tokenIndex: 0 }),
  cueRow({ blockId: blockOf(1), tokenIndex: 1, expectedHand: 'right', outcome: 'missed' }),
]

/** What the live screen counted for that same workout: far more than three. */
const LIVE: LiveCounts = {
  v: 1,
  total: 61,
  left: 31,
  right: 30,
  extra: 4,
  adaptations: 0,
  source: 'tracker',
  rounds: [
    { roundIndex: 0, actual: 28, target: 30, left: 14, right: 14 },
    { roundIndex: 1, actual: 31, target: 30, left: 16, right: 15 },
  ],
}

function harness() {
  const db = createMigratedDb()
  const repos = { sessions: new SessionRepository(db), workouts: new WorkoutRepository(db) }
  let n = 0
  const save = (over: Partial<Parameters<typeof persistWorkoutSession>[0]> = {}): string => {
    n += 1
    return persistWorkoutSession({
      db,
      ...repos,
      workout: WORKOUT,
      realized: [0, 1].map((round) => ({
        blockId: blockOf(round),
        tokens: WORKOUT.schedule[round]!.blocks[0]!.tokens,
      })),
      cueResults: CUES,
      startedMonotonicMs: 1_000,
      endedMonotonicMs: 301_000,
      activeDurationMs: 300_000,
      endedAtIso: `2026-11-2${n}T10:00:00.000Z`,
      liveCounts: LIVE,
      ...over,
    }).sessionId
  }
  /** As a build from before migration 009 would have left the row. */
  const forgetLiveCounts = (sessionId: string): void => {
    db.prepareSync('UPDATE sessions SET live_counts_json = NULL WHERE id = ?').executeSync([
      sessionId,
    ])
  }
  return { db, repos, save, forgetLiveCounts }
}

/** A punch as `SimulatedPunchSource` builds one. */
const simulatedPunch = (id: string): TrackerPunchEvent => ({
  id,
  sourceFrameId: `sim-frame-${id}`,
  deviceId: 'sim-left',
  hand: 'left',
  trackerTimestampMs: 1,
  receivedMonotonicTimeMs: 1,
  receivedWallTimeIso: '2026-11-27T00:00:00.000Z',
  recovered: false,
  decoderId: SIM_DECODER_ID,
  decoderVersion: '1.0.0',
  velocityUnit: 'unknown',
  qualityFlags: [],
})

describe('titles', () => {
  it('names a library workout by its name and a built one as the app does', () => {
    expect(workoutTitle('three-round-fundamentals')).toBe(
      WORKOUT.recipe && 'Three-Round Fundamentals',
    )
    expect(workoutTitle('gen-build-abc')).toBe(BUILT_WORKOUT_TITLE)
  })
})

describe('the history list', () => {
  it('lists saved sessions newest first, in the order they were saved', () => {
    const h = harness()
    const first = h.save()
    const second = h.save({ cancelled: true })
    const third = h.save()

    const { rows, hasMore } = listSessionHistory(h.repos)
    expect(rows.map((r) => r.sessionId)).toEqual([third, second, first])
    expect(hasMore).toBe(false)
    expect(rows[1]).toMatchObject({
      title: 'Three-Round Fundamentals',
      when: '2026-11-22T10:00:00.000Z',
      stopped: true,
      activeDurationMs: 300_000,
      punches: 61,
      punchBasis: 'live',
      simulated: false,
    })
  })

  it('does not depend on either clock: later monotonic time, earlier wall time, still save order', () => {
    const h = harness()
    const first = h.save({ startedMonotonicMs: 9_000_000, endedAtIso: '2030-01-01T00:00:00.000Z' })
    const second = h.save({ startedMonotonicMs: 10, endedAtIso: '2020-01-01T00:00:00.000Z' })
    expect(listSessionHistory(h.repos).rows.map((r) => r.sessionId)).toEqual([second, first])
  })

  it('pages by the last row shown, and says when there is more', () => {
    const h = harness()
    const ids = [h.save(), h.save(), h.save(), h.save(), h.save()]

    const page1 = listSessionHistory(h.repos, { limit: 2 })
    expect(page1.rows.map((r) => r.sessionId)).toEqual([ids[4], ids[3]])
    expect(page1.hasMore).toBe(true)

    // A session saved between two page loads does not shift the next page.
    h.save()
    const page2 = listSessionHistory(h.repos, { limit: 2, before: page1.rows[1]!.seq })
    expect(page2.rows.map((r) => r.sessionId)).toEqual([ids[2], ids[1]])
    const page3 = listSessionHistory(h.repos, { limit: 2, before: page2.rows[1]!.seq })
    expect(page3.rows.map((r) => r.sessionId)).toEqual([ids[0]])
    expect(page3.hasMore).toBe(false)
  })

  it('leaves out anything that is not a finished workout', () => {
    const h = harness()
    h.repos.sessions.create({ id: 'lab', mode: 'velocity-test', status: 'completed' })
    h.repos.sessions.create({ id: 'open', mode: 'punchcraft', status: 'work' })
    const saved = h.save()
    expect(listSessionHistory(h.repos).rows.map((r) => r.sessionId)).toEqual([saved])
  })

  it('shows an older session by its matched punches, and says that is what they are', () => {
    const h = harness()
    const older = h.save()
    h.forgetLiveCounts(older)
    expect(listSessionHistory(h.repos).rows[0]).toMatchObject({
      punches: 3,
      punchBasis: 'matched',
      simulated: false,
    })
  })

  it('knows an older session was simulated from the punches it stored', () => {
    const h = harness()
    const older = h.save({
      punchEvents: [simulatedPunch('p1')],
      cueResults: [cueRow({ observedEventId: 'p1' })],
    })
    h.forgetLiveCounts(older)
    expect(listSessionHistory(h.repos).rows[0]?.simulated).toBe(true)
  })

  it('cannot tell where an older session with no punch at all came from', () => {
    const h = harness()
    const older = h.save({ cueResults: [cueRow({ outcome: 'missed' })] })
    h.forgetLiveCounts(older)
    expect(listSessionHistory(h.repos).rows[0]).toMatchObject({ punches: 0, simulated: null })
  })

  it('says simulated for a session that recorded it', () => {
    const h = harness()
    h.save({ liveCounts: { ...LIVE, source: 'simulated' } })
    expect(listSessionHistory(h.repos).rows[0]?.simulated).toBe(true)
  })
})

describe('one session, as the summary screen shows it', () => {
  it('shows what the live screen counted — not the three punches the cue results hold', () => {
    const h = harness()
    const read = readSessionSummary(h.repos, h.save())
    expect(read).toMatchObject({
      title: 'Three-Round Fundamentals',
      stopped: false,
      simulated: false,
      roundsPlanned: WORKOUT.schedule.length,
      roundsReached: 2,
    })
    expect(read?.summary).toMatchObject({
      countBasis: 'live',
      totalPunches: 61,
      leftRightSplit: { left: 31, right: 30 },
      extraPunches: 4,
      recipeName: 'Three-Round Fundamentals',
    })
    expect(read?.summary.perRound.map((r) => [r.roundIndex, r.actual])).toEqual([
      [0, 28],
      [1, 31],
    ])
    // Three of four called punches landed: that still comes from the rows.
    expect(read?.summary.handSequenceMatchPercent).toBe(75)
  })

  it('works out the rate over the time worked, not the minutes scheduled', () => {
    const h = harness()
    // 61 punches in the stored five minutes.
    expect(readSessionSummary(h.repos, h.save())?.summary.avgRatePerMin).toBe(12.2)
  })

  it('reads an older session as matched punches, and lists only the rounds that ran', () => {
    const h = harness()
    const older = h.save({ cancelled: true })
    h.forgetLiveCounts(older)
    const read = readSessionSummary(h.repos, older)
    expect(read).toMatchObject({ stopped: true, roundsReached: 2 })
    expect(read?.summary).toMatchObject({ countBasis: 'matched', totalPunches: 3 })
    // The third round was never reached: it is not there as "0 of N".
    expect(read?.summary.perRound.map((r) => r.roundIndex)).toEqual([0, 1])
  })

  it('does not trust a live-counts column it cannot read', () => {
    const h = harness()
    const id = h.save()
    h.db
      .prepareSync('UPDATE sessions SET live_counts_json = ? WHERE id = ?')
      .executeSync(['{"v":1,"total":"lots"}', id])
    expect(readSessionSummary(h.repos, id)?.summary.countBasis).toBe('matched')
  })

  it('has nothing to show for a session that is not there, or is not a workout', () => {
    const h = harness()
    h.repos.sessions.create({ id: 'lab', mode: 'velocity-test', status: 'completed' })
    h.repos.sessions.create({ id: 'bare', mode: 'punchcraft', status: 'completed' })
    expect(readSessionSummary(h.repos, 'missing')).toBeNull()
    expect(readSessionSummary(h.repos, 'lab')).toBeNull()
    expect(readSessionSummary(h.repos, 'bare')).toBeNull()

    // Even one that somehow has a stored run: this reads workouts, not labs.
    h.repos.workouts.saveGeneratedWorkout(
      WORKOUT,
      [{ blockId: blockOf(0), tokens: WORKOUT.schedule[0]!.blocks[0]!.tokens }],
      'lab',
    )
    expect(readSessionSummary(h.repos, 'lab')).toBeNull()
  })

  it('agrees with the list about the same session', () => {
    const h = harness()
    const id = h.save({ cancelled: true, liveCounts: { ...LIVE, source: 'simulated' } })
    const row = listSessionHistory(h.repos).rows[0]!
    const read = readSessionSummary(h.repos, id)!
    expect(read.summary.totalPunches).toBe(row.punches)
    expect(read.summary.countBasis).toBe(row.punchBasis)
    expect([read.title, read.when, read.stopped, read.simulated]).toEqual([
      row.title,
      row.when,
      row.stopped,
      row.simulated,
    ])
  })
})
