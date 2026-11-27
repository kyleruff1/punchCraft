/**
 * The stored live counts are JSON, and JSON has no types: what comes back
 * is checked field by field, and one bad field distrusts the whole record.
 */
import { LIVE_COUNTS_VERSION, parseLiveCounts, type LiveCounts } from '../liveCounts'

const good: LiveCounts = {
  v: LIVE_COUNTS_VERSION,
  total: 61,
  left: 30,
  right: 31,
  extra: 4,
  adaptations: 1,
  source: 'tracker',
  rounds: [
    { roundIndex: 0, actual: 28, target: 30, left: 14, right: 14 },
    { roundIndex: 1, actual: 31, target: 30, left: 15, right: 16 },
  ],
}
const withField = (key: string, value: unknown): string => JSON.stringify({ ...good, [key]: value })

describe('parseLiveCounts', () => {
  it('reads back exactly what was stored', () => {
    expect(parseLiveCounts(JSON.stringify(good))).toEqual(good)
  })

  it('drops fields it does not know rather than carrying them through', () => {
    const parsed = parseLiveCounts(JSON.stringify({ ...good, surprise: 'x' }))
    expect(parsed).toEqual(good)
  })

  it('reads an absent column as not recorded', () => {
    expect(parseLiveCounts(null)).toBeNull()
    expect(parseLiveCounts(undefined)).toBeNull()
  })

  it('reads anything that is not the record as not recorded', () => {
    for (const json of ['', 'not json', 'null', '[]', '"a string"', '7']) {
      expect(parseLiveCounts(json)).toBeNull()
    }
  })

  it('does not trust a version it does not know', () => {
    expect(parseLiveCounts(withField('v', 2))).toBeNull()
    expect(parseLiveCounts(withField('v', '1'))).toBeNull()
  })

  it.each([
    ['total', -1],
    ['total', 1.5],
    ['total', '61'],
    ['left', null],
    ['right', undefined],
    ['extra', NaN],
    ['adaptations', 'none'],
    ['source', 'gloves'],
    ['source', undefined],
    ['rounds', 'two'],
    ['rounds', [{ roundIndex: 0, actual: 28, target: 30, left: 14 }]],
    ['rounds', [{ roundIndex: 0, actual: '28', target: 30, left: 14, right: 14 }]],
    ['rounds', [null]],
  ])('distrusts the whole record when %s is %p', (key, value) => {
    expect(parseLiveCounts(withField(key, value))).toBeNull()
  })

  it('accepts a session in which no round was reached', () => {
    expect(parseLiveCounts(withField('rounds', []))?.rounds).toEqual([])
  })
})
