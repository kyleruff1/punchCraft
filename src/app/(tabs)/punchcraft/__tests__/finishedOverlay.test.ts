import { summaryOfferFor } from '../_finishedOverlay'
import type { SessionEndOutcome } from '../_useWorkoutRunner'

const persisted = (cancelled: boolean): SessionEndOutcome => ({
  status: 'persisted',
  cancelled,
  session: { sessionId: 'ses_1', generatedWorkoutId: 'w@1', cueResultCount: 4, adaptationCount: 0 },
})

describe('the summary offered when a workout ends', () => {
  it('is offered for a workout that ran its course and was saved', () => {
    expect(summaryOfferFor('completed', persisted(false))).toBe('ses_1')
  })

  it('is not offered for a stopped workout — keep-or-discard is still open', () => {
    expect(summaryOfferFor('cancelled', persisted(true))).toBeNull()
  })

  it('is not offered when nothing was saved', () => {
    expect(summaryOfferFor('completed', null)).toBeNull()
    expect(
      summaryOfferFor('completed', { status: 'failed', cancelled: false, error: 'x' }),
    ).toBeNull()
    expect(summaryOfferFor('completed', { status: 'skipped', cancelled: false })).toBeNull()
    expect(
      summaryOfferFor('completed', { status: 'nothing-to-persist', cancelled: false }),
    ).toBeNull()
  })

  it('is not offered while the workout is still running', () => {
    expect(summaryOfferFor('work', persisted(false))).toBeNull()
  })
})
