import {
  AMBIENT_LIMITS,
  ambientCapturesToPrune,
  type AmbientCaptureSummary,
} from '../ambientCapture'

const NOW = Date.parse('2026-11-26T12:00:00.000Z')
const DAY = 86_400_000
const capture = (id: string, daysAgo: number, frames: number): AmbientCaptureSummary => ({
  id,
  startedAtIso: new Date(NOW - daysAgo * DAY).toISOString(),
  frames,
})

describe('ambientCapturesToPrune', () => {
  it('keeps everything inside both limits', () => {
    const captures = [capture('a', 1, 1_000), capture('b', 30, 2_000), capture('c', 89, 3_000)]
    expect(ambientCapturesToPrune(captures, NOW)).toEqual([])
  })

  it('lets go of a capture older than the retention', () => {
    const captures = [capture('new', 1, 10), capture('edge', 90, 10), capture('old', 91, 10)]
    // Exactly at the retention is still inside it.
    expect(ambientCapturesToPrune(captures, NOW)).toEqual(['old'])
  })

  it('past the frame cap, lets the oldest go first', () => {
    const captures = [
      capture('oldest', 40, 200_000),
      capture('newest', 1, 200_000),
      capture('middle', 20, 200_000),
      capture('older', 30, 200_000),
    ]
    // newest + middle + older = 600k crosses the 500k cap at `older`, which
    // is the last one kept; everything before it in time goes.
    expect(ambientCapturesToPrune(captures, NOW)).toEqual(['oldest'])
  })

  it('keeps a single capture that is over the cap on its own', () => {
    expect(ambientCapturesToPrune([capture('huge', 1, 2_000_000)], NOW)).toEqual([])
    // ...and prunes what is behind it.
    expect(
      ambientCapturesToPrune([capture('huge', 1, 2_000_000), capture('behind', 2, 5)], NOW),
    ).toEqual(['behind'])
  })

  it('applies both rules together', () => {
    const captures = [
      capture('a', 1, 400_000),
      capture('b', 2, 400_000),
      capture('c', 3, 1),
      capture('d', 200, 1),
    ]
    expect(ambientCapturesToPrune(captures, NOW).sort()).toEqual(['c', 'd'])
  })

  it('keeps a capture whose date it cannot read', () => {
    const broken: AmbientCaptureSummary = { id: 'x', startedAtIso: 'not a date', frames: 1 }
    expect(ambientCapturesToPrune([broken], NOW)).toEqual([])
  })

  it('takes other limits', () => {
    const captures = [capture('a', 1, 10), capture('b', 5, 10)]
    expect(ambientCapturesToPrune(captures, NOW, { retentionDays: 3, maxFrames: 100 })).toEqual([
      'b',
    ])
  })

  it('defaults to ninety days and half a million frames', () => {
    expect(AMBIENT_LIMITS).toEqual({ retentionDays: 90, maxFrames: 500_000 })
  })
})
