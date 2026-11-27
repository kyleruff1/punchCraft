/**
 * Whether the "Workout complete" overlay may offer the session's summary.
 *
 * Only for a workout that ran its course and was saved. A stopped workout is
 * saved too — but the athlete has not yet answered keep-or-discard, and a
 * summary opened before that could be of a session about to be deleted. It
 * is in History once it is kept.
 *
 * Pulled out of the live screen so the rule has a test of its own: the
 * screen's tests drive its phases through the store, and never reach a real
 * save.
 */
import type { SessionEndOutcome } from './_useWorkoutRunner'

/** The saved session to offer, or null when there is nothing to offer. */
export function summaryOfferFor(phase: string, outcome: SessionEndOutcome | null): string | null {
  return phase === 'completed' && outcome?.status === 'persisted' ? outcome.session.sessionId : null
}
