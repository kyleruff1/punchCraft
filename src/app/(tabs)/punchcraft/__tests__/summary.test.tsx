/**
 * Summary screen (M33-08).
 *
 * The presentation rules under test are the ones that would quietly turn a
 * measurement into an accusation: nothing scolds a short count, an
 * unmeasured figure is absent rather than zero, and velocity says what it
 * is instead of implying a physical unit.
 */
import React from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'

/** What the route was opened with — `summary?id=…`. */
let mockParams: { id?: string } = {}

jest.mock('expo-router', () => {
  function Stack() {
    return null
  }
  function Screen() {
    return null
  }
  Stack.Screen = Screen
  return {
    Stack,
    useRouter: () => ({ back: jest.fn() }),
    useLocalSearchParams: () => mockParams,
  }
})

import SummaryScreen, { MATCHED_ONLY_NOTE, NOT_RECORDED, SHORT_COUNT_NOTE } from '../summary'
import { computeWorkoutSummary, type SummaryCueResult } from '@domain/programs/workoutSummary'
import { threeRoundFundamentals } from '@domain/workout/samples'
import type { LiveCounts } from '@domain/programs/liveCounts'
import { formatSessionWhen } from '@domain/session/sessionDisplay'
import { createMigratedDb } from '@storage/__tests__/helpers/memoryDb'
import { __setWorkoutPersistenceForTests } from '@storage/getWorkoutPersistence'
import { persistWorkoutSession } from '@storage/persistWorkoutSession'
import { SessionRepository } from '@storage/repositories/SessionRepository'
import { WorkoutRepository } from '@storage/repositories/WorkoutRepository'

const WORKOUT = threeRoundFundamentals
const BLOCK = WORKOUT.schedule[0]!.blocks[0]!.id

function rows(count: number, over: Partial<SummaryCueResult> = {}): SummaryCueResult[] {
  return Array.from({ length: count }, (_, i) => ({
    blockId: BLOCK,
    tokenIndex: i,
    expectedHand: i % 2 === 0 ? ('left' as const) : ('right' as const),
    outcome: 'matched' as const,
    offsetMs: 0,
    velocityRaw: 10,
    velocityUnit: 'tracker-unit',
    capabilityTier: 'hand-timestamp',
    ...over,
  }))
}

const mounted: ReactTestRenderer[] = []

function render(cueResults: SummaryCueResult[], extras = 0): ReactTestRenderer {
  const summary = computeWorkoutSummary({
    workout: WORKOUT,
    cueResults,
    extraPunches: extras,
  })
  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<SummaryScreen summary={summary} />)
  })
  mounted.push(tree)
  return tree
}

afterEach(() => {
  act(() => {
    for (const tree of mounted.splice(0)) tree.unmount()
  })
  mockParams = {}
  __setWorkoutPersistenceForTests(null)
})

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
}

const allText = (tree: ReactTestRenderer): string => textOf(tree.root)

function nodes(tree: ReactTestRenderer, testID: string): ReactTestInstance[] {
  return tree.root.findAllByProps({ testID }, { deep: false })
}

// ---------------------------------------------------------------------------

describe('the screen renders doc §24', () => {
  it('shows the headline count badge and the per-round breakdown', () => {
    const tree = render(rows(30))
    expect(() => tree.root.findByProps({ testID: 'summary-screen' })).not.toThrow()
    expect(() => tree.root.findByProps({ testID: 'round-0' })).not.toThrow()
    expect(() => tree.root.findByProps({ testID: 'round-2' })).not.toThrow()
  })

  it('shows the lead metrics', () => {
    const tree = render(rows(30), 4)
    expect(textOf(tree.root.findByProps({ testID: 'summary-extras' }))).toContain('4')
    expect(() => tree.root.findByProps({ testID: 'summary-rate' })).not.toThrow()
    expect(() => tree.root.findByProps({ testID: 'summary-left-right' })).not.toThrow()
  })

  it('shows the seed and versions that make a replay possible', () => {
    const tree = render(rows(10))
    const provenance = textOf(tree.root.findByProps({ testID: 'summary-provenance' }))
    expect(provenance).toContain(WORKOUT.recipe.seed)
    expect(provenance).toContain('calculation')
  })

  it('handles having no summary at all', () => {
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<SummaryScreen />)
    })
    mounted.push(tree)
    expect(() => tree.root.findByProps({ testID: 'summary-empty' })).not.toThrow()
  })
})

describe('a short count is a measurement, not a verdict (doc §21, D13)', () => {
  it('shows the transmit-floor note when short', () => {
    const tree = render(rows(10))
    expect(textOf(tree.root.findByProps({ testID: 'short-count-note' }))).toBe(SHORT_COUNT_NOTE)
  })

  it('does not show it when the target was met', () => {
    // The note explains a low number; it would be noise on a met target.
    const tree = render(rows(WORKOUT.recipe.totalPunchGoal))
    expect(nodes(tree, 'short-count-note')).toHaveLength(0)
  })

  it('never scolds', () => {
    const text = allText(render(rows(3))).toLowerCase()
    for (const word of ['fail', 'failed', 'poor', 'bad', 'weak', 'only', 'try harder']) {
      expect(text).not.toContain(word)
    }
  })

  it('uses no letter grade', () => {
    const text = allText(render(rows(3)))
    expect(text).not.toMatch(/\bgrade\b/i)
    expect(text).not.toMatch(/\b[A-F][+-]?\b\s*(grade|rating)/)
  })
})

describe('absent, never zero (D11)', () => {
  it('omits velocity metrics when nothing measured them', () => {
    const tree = render(rows(20, { velocityRaw: null, velocityUnit: null }))
    expect(nodes(tree, 'summary-avg-velocity')).toHaveLength(0)
    expect(nodes(tree, 'summary-peak-velocity')).toHaveLength(0)
  })

  it('says plainly that no velocity was recorded', () => {
    const tree = render(rows(20, { velocityRaw: null, velocityUnit: null }))
    expect(textOf(tree.root.findByProps({ testID: 'velocity-representation' }))).toMatch(
      /no velocity/i,
    )
  })

  it('shows them when velocity was recorded', () => {
    const tree = render(rows(20))
    expect(() => tree.root.findByProps({ testID: 'summary-avg-velocity' })).not.toThrow()
  })
})

describe('velocity is disclosed, not implied (spec §8.5, §4.3)', () => {
  it('always renders the representation line', () => {
    const tree = render(rows(20))
    expect(() => tree.root.findByProps({ testID: 'velocity-representation' })).not.toThrow()
  })

  it('labels velocity figures as tracker-reported', () => {
    expect(allText(render(rows(20)))).toContain('tracker-reported velocity')
  })

  it('never states a physical unit', () => {
    expect(allText(render(rows(20)))).not.toMatch(/\bmph\b|\bm\/s\b|newton|joule/i)
  })
})

describe('the score is punch count, not a per-combo sequence grade', () => {
  // The sequence score was dropped from the surface: the athlete's score is
  // punch count, with the left/right breakout and velocity kept as analytics.
  // So the summary no longer shows a "Sequence" tile, and the D4 honesty tests
  // that guarded its resolved label retire with it — the never-hardcode-a-claim
  // property is still covered for the velocity label and the provenance line.
  it('shows no sequence tile', () => {
    expect(nodes(render(rows(20)), 'summary-sequence')).toHaveLength(0)
  })

  it('never claims technique accuracy anywhere on the summary', () => {
    expect(allText(render(rows(20)))).not.toMatch(/technique accuracy/i)
  })

  it('still shows the left/right breakout and the punch count', () => {
    const tree = render(rows(20))
    expect(() => tree.root.findByProps({ testID: 'summary-left-right' })).not.toThrow()
  })
})

describe('adaptations are explained, not hidden', () => {
  it('says nothing when the plan never adapted', () => {
    const tree = render(rows(20))
    expect(nodes(tree, 'adaptation-note')).toHaveLength(0)
  })

  it('reports how many times the plan changed', () => {
    const summary = computeWorkoutSummary({
      workout: WORKOUT,
      cueResults: rows(20),
      adaptations: [
        { decidedAtMonotonicMs: 1, boundary: 'rest' },
        { decidedAtMonotonicMs: 2, boundary: 'rest' },
      ],
    })
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<SummaryScreen summary={summary} />)
    })
    mounted.push(tree)
    expect(textOf(tree.root.findByProps({ testID: 'adaptation-note' }))).toContain('2 times')
  })
})

// ---------------------------------------------------------------------------

describe('a saved session, opened by its id (`summary?id=…`)', () => {
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

  /** A real database with one saved session in it, as the runner writes one. */
  function saved(over: { cancelled?: boolean; liveCounts?: LiveCounts | null } = {}): {
    id: string
    forgetLiveCounts(): void
  } {
    const db = createMigratedDb()
    const repos = { db, sessions: new SessionRepository(db), workouts: new WorkoutRepository(db) }
    __setWorkoutPersistenceForTests(repos)
    const { sessionId } = persistWorkoutSession({
      ...repos,
      workout: WORKOUT,
      realized: [0, 1].map((round) => ({
        blockId: WORKOUT.schedule[round]!.blocks[0]!.id,
        tokens: WORKOUT.schedule[round]!.blocks[0]!.tokens,
      })),
      cueResults: rows(3).map((r) => ({
        ...r,
        repeatIndex: 0,
        expectedType: null,
        observedEventId: null,
        velocityCalibrated: null,
        decoderVersion: '1.0.0',
        calculationVersion: '1.1.0',
      })),
      startedMonotonicMs: 0,
      endedMonotonicMs: 300_000,
      activeDurationMs: 300_000,
      endedAtIso: '2026-11-26T15:07:00.000Z',
      cancelled: over.cancelled ?? false,
      ...(over.liveCounts === null ? {} : { liveCounts: over.liveCounts ?? LIVE }),
    })
    return {
      id: sessionId,
      forgetLiveCounts: () =>
        db.prepareSync('UPDATE sessions SET live_counts_json = NULL').executeSync([]),
    }
  }

  function open(id: string): ReactTestRenderer {
    mockParams = { id }
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<SummaryScreen />)
    })
    mounted.push(tree)
    return tree
  }

  it('reads the session from the database and shows what the live screen counted', () => {
    const tree = open(saved().id)
    expect(allText(tree)).toContain('Three-Round Fundamentals')
    expect(allText(tree)).toContain('61')
    expect(textOf(nodes(tree, 'summary-when')[0]!)).toBe(
      formatSessionWhen('2026-11-26T15:07:00.000Z'),
    )
    expect(textOf(nodes(tree, 'summary-extras')[0]!)).toContain('4')
    // Only the two rounds that ran.
    expect(nodes(tree, 'round-0')).toHaveLength(1)
    expect(nodes(tree, 'round-1')).toHaveLength(1)
    expect(nodes(tree, 'round-2')).toHaveLength(0)
    expect(nodes(tree, 'summary-basis')).toHaveLength(0)
    expect(nodes(tree, 'summary-stopped')).toHaveLength(0)
    expect(nodes(tree, 'summary-simulated')).toHaveLength(0)
  })

  it('says a stopped session was stopped, and where — and does not blame the trackers', () => {
    const tree = open(saved({ cancelled: true }).id)
    expect(textOf(nodes(tree, 'summary-stopped')[0]!)).toBe('Stopped in round 2 of 3')
    expect(allText(tree)).not.toContain(SHORT_COUNT_NOTE)
  })

  it('says so when the punches were simulated', () => {
    const tree = open(saved({ liveCounts: { ...LIVE, source: 'simulated' } }).id)
    expect(textOf(nodes(tree, 'summary-simulated')[0]!)).toBe('Simulated punches')
  })

  it('labels an older session’s count as matched punches, and its extras as not recorded', () => {
    const session = saved()
    session.forgetLiveCounts()
    const tree = open(session.id)
    expect(textOf(nodes(tree, 'summary-basis')[0]!)).toBe('Matched punches')
    expect(allText(tree)).toContain(MATCHED_ONLY_NOTE)
    expect(textOf(nodes(tree, 'summary-extras')[0]!)).toContain(NOT_RECORDED)
    expect(textOf(nodes(tree, 'summary-extras')[0]!)).not.toContain('0')
    // The count is short because it is partial, not because of the trackers.
    expect(allText(tree)).not.toContain(SHORT_COUNT_NOTE)
  })

  it('says a session it cannot find is not saved here', () => {
    saved()
    const tree = open('ses_missing')
    expect(textOf(nodes(tree, 'summary-empty')[0]!)).toBe('That session is not saved here.')
  })

  it('says the same when the database cannot be read at all', () => {
    __setWorkoutPersistenceForTests({
      get sessions(): never {
        throw new Error('database unavailable')
      },
    } as never)
    const tree = open('ses_any')
    expect(textOf(nodes(tree, 'summary-empty')[0]!)).toBe('That session is not saved here.')
  })
})
