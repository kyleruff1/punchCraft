/**
 * Saved workout sessions, read back for the app to show.
 *
 * One path for every surface that shows a stored session: the history list,
 * the summary a list row opens, and the summary offered when a workout has
 * just ended. They read the database, so they agree with each other by
 * construction — the just-ended summary is not computed from memory and so
 * cannot say something history will later contradict.
 *
 * What a stored session can and cannot say (see migration 009):
 *
 * - **Saved by this build or later:** the session carries what the live
 *   screen counted. Totals, the split and each round are those counts.
 * - **Saved before:** only the punches that answered a called combination
 *   were kept. The summary's `countBasis` is then `'matched'`, and a surface
 *   must label the number as that and say the full count was not kept —
 *   never show it as the total, and never show the missing figures as zero.
 *
 * No React, Expo or BLE imports — this is the storage layer (spec §15.1).
 */
import { parseLiveCounts } from '@domain/programs/liveCounts'
import {
  LANDED_OUTCOMES,
  computeWorkoutSummary,
  type WorkoutSummaryData,
} from '@domain/programs/workoutSummary'
import { getSampleWorkout, isSampleWorkoutKey } from '@domain/workout/samples'
import { SIM_DECODER_ID } from '@simulation/SimulatedPunchSource'

import type { SessionRepository, SessionRow } from './repositories/SessionRepository'
import { workoutIdOfPlanId, type WorkoutRepository } from './repositories/WorkoutRepository'
import type { SessionMode } from './migrations/003_sessions'

/** The repositories this reads through — `getWorkoutPersistence()` has both. */
export interface HistoryRepositories {
  sessions: SessionRepository
  workouts: WorkoutRepository
}

/**
 * The modes a workout session has been saved under. `punchcraft` is the only
 * one written today; `puncheokie` is what the same sessions were called
 * before the rename, and migration 003's CHECK still allows it.
 */
const WORKOUT_MODES: readonly SessionMode[] = ['punchcraft', 'puncheokie']

export const HISTORY_PAGE_SIZE = 30

/** What a built (not library) workout is called everywhere in the app. */
export const BUILT_WORKOUT_TITLE = 'Custom Session'

export function workoutTitle(workoutId: string): string {
  return isSampleWorkoutKey(workoutId) ? getSampleWorkout(workoutId).name : BUILT_WORKOUT_TITLE
}

export interface SessionHistoryRow {
  sessionId: string
  /** Place in save order. Pass the last row's as `before` for the next page. */
  seq: number
  title: string
  /** ISO wall time the session ended — for display only, never ordering. */
  when: string
  /** The athlete stopped it early and kept it. */
  stopped: boolean
  activeDurationMs: number
  punches: number
  /** What `punches` counts — see the header. */
  punchBasis: 'live' | 'matched'
  /** Null when it cannot be told: an older session that stored no punch. */
  simulated: boolean | null
}

const whenOf = (session: SessionRow): string => session.endedAt ?? session.createdAt

/**
 * One page of history, newest first, in the order the sessions were saved.
 *
 * Three queries for the page, whatever its size: the sessions, then — only
 * for sessions that predate the live counts — their landed cue results and
 * whether a simulated punch was stored.
 */
export function listSessionHistory(
  repos: HistoryRepositories,
  options: { limit?: number; before?: number } = {},
): { rows: SessionHistoryRow[]; hasMore: boolean } {
  const limit = options.limit ?? HISTORY_PAGE_SIZE
  // One more than asked for, to know whether there is another page.
  const sessions = repos.sessions.listSaved({
    modes: WORKOUT_MODES,
    limit: limit + 1,
    ...(options.before === undefined ? {} : { before: options.before }),
  })
  const page = sessions.slice(0, limit)
  const counted = page.map((session) => ({
    session,
    counts: parseLiveCounts(session.liveCountsJson),
  }))

  const older = counted.filter((c) => c.counts === null).map((c) => c.session.id)
  const landed = repos.workouts.countCueOutcomes(older, LANDED_OUTCOMES)
  const simulated = repos.sessions.sessionsWithDecoder(older, SIM_DECODER_ID)

  const rows = counted.map(({ session, counts }): SessionHistoryRow => {
    const matched = landed.get(session.id) ?? 0
    return {
      sessionId: session.id,
      seq: session.seq,
      title: workoutTitle(workoutIdOfPlanId(session.generatedWorkoutId ?? '')),
      when: whenOf(session),
      stopped: session.status === 'cancelled',
      activeDurationMs: session.activeDurationMs,
      punches: counts ? counts.total : matched,
      punchBasis: counts ? 'live' : 'matched',
      simulated: counts
        ? counts.source === 'simulated'
        : simulated.has(session.id)
          ? true
          : matched > 0
            ? false
            : null,
    }
  })
  return { rows, hasMore: sessions.length > limit }
}

export interface StoredSessionSummary {
  sessionId: string
  title: string
  /** ISO wall time the session ended — for display only. */
  when: string
  stopped: boolean
  simulated: boolean | null
  /** How many rounds the plan had, and how many were reached. */
  roundsPlanned: number
  roundsReached: number
  /** `summary.countBasis` says whether its totals are the live counts. */
  summary: WorkoutSummaryData
}

/**
 * One stored session as the summary screen renders it, or null when there is
 * no such session or it ran no stored workout.
 */
export function readSessionSummary(
  repos: HistoryRepositories,
  sessionId: string,
): StoredSessionSummary | null {
  const session = repos.sessions.getById(sessionId)
  if (!session || !WORKOUT_MODES.includes(session.mode)) return null
  const found = repos.workouts.getWorkoutBySession(sessionId)
  if (!found) return null

  const cueResults = repos.workouts.listCueResults(sessionId)
  const liveCounts = parseLiveCounts(session.liveCountsJson)
  const title = workoutTitle(found.workout.id)
  const summary = computeWorkoutSummary({
    workout: found.workout,
    cueResults,
    recipeName: title,
    activeDurationMs: session.activeDurationMs,
    // The realized stream: what actually ran, never the plan (D8).
    reachedBlockIds: found.realized.map((block) => block.blockId),
    ...(liveCounts ? { liveCounts } : {}),
  })

  const landed = cueResults.filter((r) => LANDED_OUTCOMES.includes(r.outcome)).length
  return {
    sessionId,
    title,
    when: whenOf(session),
    stopped: session.status === 'cancelled',
    simulated: liveCounts
      ? liveCounts.source === 'simulated'
      : repos.sessions.sessionsWithDecoder([sessionId], SIM_DECODER_ID).has(sessionId)
        ? true
        : landed > 0
          ? false
          : null,
    roundsPlanned: found.workout.schedule.length,
    roundsReached: summary.perRound.length,
    summary,
  }
}
