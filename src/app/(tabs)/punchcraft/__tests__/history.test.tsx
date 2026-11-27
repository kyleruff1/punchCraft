/**
 * The history list, against a real database written the way the runner
 * writes it.
 */
import React from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'

/** Every `href` a row linked to, in render order. */
const mockLinks: unknown[] = []

jest.mock('expo-router', () => {
  const ReactInMock = jest.requireActual<typeof React>('react')
  function Stack() {
    return null
  }
  function Screen() {
    return null
  }
  Stack.Screen = Screen
  function Link({ href, children }: { href: unknown; children: React.ReactNode }) {
    mockLinks.push(href)
    return children
  }
  return {
    Stack,
    Link,
    // Runs once the screen has mounted, as a focused screen's effect does.
    useFocusEffect: (fn: () => void) => ReactInMock.useEffect(() => fn(), [fn]),
  }
})

import HistoryScreen, { EMPTY_HISTORY, HISTORY_UNREADABLE, punchesLabel } from '../history'
import { formatSessionWhen } from '@domain/session/sessionDisplay'
import type { LiveCounts } from '@domain/programs/liveCounts'
import { threeRoundFundamentals } from '@domain/workout/samples'
import { createMigratedDb } from '@storage/__tests__/helpers/memoryDb'
import { __setWorkoutPersistenceForTests } from '@storage/getWorkoutPersistence'
import { persistWorkoutSession } from '@storage/persistWorkoutSession'
import { SessionRepository } from '@storage/repositories/SessionRepository'
import { WorkoutRepository } from '@storage/repositories/WorkoutRepository'
import { HISTORY_PAGE_SIZE } from '@storage/sessionHistory'

const WORKOUT = threeRoundFundamentals
const BLOCK = WORKOUT.schedule[0]!.blocks[0]!

const LIVE: LiveCounts = {
  v: 1,
  total: 187,
  left: 94,
  right: 93,
  extra: 2,
  adaptations: 0,
  source: 'tracker',
  rounds: [{ roundIndex: 0, actual: 180, target: 200, left: 90, right: 90 }],
}

function database() {
  const db = createMigratedDb()
  const repos = { db, sessions: new SessionRepository(db), workouts: new WorkoutRepository(db) }
  __setWorkoutPersistenceForTests(repos)
  let n = 0
  const save = (over: { cancelled?: boolean; liveCounts?: LiveCounts } = {}): string => {
    n += 1
    return persistWorkoutSession({
      ...repos,
      workout: WORKOUT,
      realized: [{ blockId: BLOCK.id, tokens: BLOCK.tokens }],
      cueResults: [0, 1, 2].map((tokenIndex) => ({
        blockId: BLOCK.id,
        repeatIndex: 0,
        tokenIndex,
        expectedHand: 'left' as const,
        expectedType: null,
        observedEventId: null,
        outcome: 'matched' as const,
        offsetMs: 0,
        velocityRaw: null,
        velocityCalibrated: null,
        velocityUnit: null,
        capabilityTier: 'hand-timestamp',
        decoderVersion: '1.0.0',
        calculationVersion: '1.1.0',
      })),
      startedMonotonicMs: 0,
      endedMonotonicMs: 760_000,
      activeDurationMs: 760_000,
      endedAtIso: new Date(2026, 10, n, 15, 7).toISOString(),
      cancelled: over.cancelled ?? false,
      liveCounts: over.liveCounts ?? LIVE,
    }).sessionId
  }
  const forgetLiveCounts = (): void =>
    void db.prepareSync('UPDATE sessions SET live_counts_json = NULL').executeSync([])
  return { save, forgetLiveCounts }
}

const mounted: ReactTestRenderer[] = []
function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<HistoryScreen />)
  })
  mounted.push(tree)
  return tree
}

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
}
const nodes = (tree: ReactTestRenderer, testID: string): ReactTestInstance[] =>
  tree.root.findAllByProps({ testID }, { deep: false })
const details = (tree: ReactTestRenderer): string[] => nodes(tree, 'history-detail').map(textOf)

beforeEach(() => {
  mockLinks.length = 0
})
afterEach(() => {
  act(() => {
    for (const tree of mounted.splice(0)) tree.unmount()
  })
  __setWorkoutPersistenceForTests(null)
})

describe('punchesLabel', () => {
  it('says what the number counts', () => {
    expect(punchesLabel({ punches: 187, punchBasis: 'live' })).toBe('187 punches')
    expect(punchesLabel({ punches: 1, punchBasis: 'live' })).toBe('1 punch')
    expect(punchesLabel({ punches: 3, punchBasis: 'matched' })).toBe('3 matched punches')
    expect(punchesLabel({ punches: 0, punchBasis: 'matched' })).toBe('0 matched punches')
  })
})

describe('the history screen', () => {
  it('says there is nothing yet, rather than showing an empty page', () => {
    database()
    const tree = render()
    expect(textOf(nodes(tree, 'history-empty')[0]!)).toBe(EMPTY_HISTORY)
    expect(nodes(tree, 'history-more')).toHaveLength(0)
  })

  it('lists saved workouts newest first: name, when, time worked, punches', () => {
    const db = database()
    const first = db.save()
    const second = db.save()
    const tree = render()

    expect(mockLinks).toEqual([
      { pathname: '/(tabs)/punchcraft/summary', params: { id: second } },
      { pathname: '/(tabs)/punchcraft/summary', params: { id: first } },
    ])
    expect(details(tree)).toEqual([
      `${formatSessionWhen(new Date(2026, 10, 2, 15, 7).toISOString())} · 12:40 worked · 187 punches`,
      `${formatSessionWhen(new Date(2026, 10, 1, 15, 7).toISOString())} · 12:40 worked · 187 punches`,
    ])
    expect(textOf(nodes(tree, `history-row-${second}`)[0]!)).toContain('Three-Round Fundamentals')
    expect(nodes(tree, 'history-stopped')).toHaveLength(0)
    expect(nodes(tree, 'history-simulated')).toHaveLength(0)
  })

  it('tags a workout that was stopped early, and one whose punches were simulated', () => {
    const db = database()
    db.save({ cancelled: true })
    db.save({ liveCounts: { ...LIVE, source: 'simulated' } })
    const tree = render()
    expect(nodes(tree, 'history-stopped')).toHaveLength(1)
    expect(nodes(tree, 'history-simulated')).toHaveLength(1)
  })

  it('calls an older session’s number what it is: matched punches', () => {
    const db = database()
    db.save()
    db.forgetLiveCounts()
    expect(details(render())[0]).toContain('3 matched punches')
  })

  it('shows one page, and loads the next under it when asked', () => {
    const db = database()
    const ids = Array.from({ length: HISTORY_PAGE_SIZE + 2 }, () => db.save())
    const tree = render()

    expect(details(tree)).toHaveLength(HISTORY_PAGE_SIZE)
    act(() => {
      nodes(tree, 'history-more')[0]!.props.onPress()
    })
    expect(details(tree)).toHaveLength(HISTORY_PAGE_SIZE + 2)
    // Oldest last, each session once.
    expect(nodes(tree, `history-row-${ids[0]}`)).toHaveLength(1)
    expect(nodes(tree, 'history-more')).toHaveLength(0)
  })

  it('says so when the saved workouts cannot be read', () => {
    __setWorkoutPersistenceForTests({
      get sessions(): never {
        throw new Error('database unavailable')
      },
    } as never)
    const tree = render()
    expect(textOf(nodes(tree, 'history-failed')[0]!)).toBe(HISTORY_UNREADABLE)
    expect(nodes(tree, 'history-empty')).toHaveLength(0)
  })
})
