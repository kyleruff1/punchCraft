/**
 * What a ring step logs (see `ringLog.ts`).
 *
 * The records are read by tools on three kinds of capture — a PC page, an
 * emulator, the tablet — so their field names and meanings are a contract.
 */
import { ringPromoteFields, ringRow, ringVisualFields } from '../ringLog'

const values = (fields: Record<string, { value: unknown }>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]))

describe('ringRow — was light shown', () => {
  it('is lit when the row on stage is this bar and paints', () => {
    expect(ringRow({ cueId: 'q12-b1#3', masked: false }, 'q12-b1#3')).toBe('lit')
  })

  it('is masked when the row on stage is this bar and is held dim', () => {
    // A bar with no call, or one inside the round's first two measures: the
    // walk still steps and still logs, and nothing lights.
    expect(ringRow({ cueId: 'q12-b1#3', masked: true }, 'q12-b1#3')).toBe('masked')
  })

  it('is other when the stage shows a different bar, or none', () => {
    expect(ringRow({ cueId: 'q12-b1#2', masked: false }, 'q12-b1#3')).toBe('other')
    expect(ringRow({ cueId: 'q12-b1#2', masked: true }, 'q12-b1#3')).toBe('other')
    expect(ringRow(null, 'q12-b1#3')).toBe('other')
  })
})

describe('workout.ring.visual', () => {
  const step = {
    epoch: 'q12-b1#3',
    ordinal: 2,
    from: 1,
    workElapsedMs: 4512.3456,
    frameMs: 258123.4567,
  }

  it('says which ring, from which, when on both clocks, and whether lit', () => {
    expect(values(ringVisualFields(step, { cueId: 'q12-b1#3', masked: false }))).toEqual({
      cueId: 'q12-b1#3',
      ordinal: 2,
      from: 1,
      workElapsedMs: 4512.3,
      frameMs: 258123.5,
      row: 'lit',
    })
  })

  it('keeps the two fields every older reader looks for, first', () => {
    // `cueId` and `ordinal` are all a capture from before this had, and a
    // reader of old captures still finds them.
    expect(Object.keys(ringVisualFields(step, null)).slice(0, 2)).toEqual(['cueId', 'ordinal'])
  })

  it('marks every field safe to log', () => {
    for (const field of Object.values(ringVisualFields(step, null)))
      expect(field.class).toBe('safe')
  })

  it('logs the step that clears the row for a new bar like any other', () => {
    const cleared = ringVisualFields(
      { ...step, ordinal: -1, from: 3 },
      { cueId: 'q12-b1#3', masked: true },
    )
    expect(values(cleared)).toMatchObject({ ordinal: -1, from: 3, row: 'masked' })
  })
})

describe('workout.ring.promote', () => {
  it('says how far the bar before got — the witness that does not need every line', () => {
    expect(
      values(
        ringPromoteFields({
          epoch: 'q12-b1#4',
          lateMs: 8.2499,
          previousEpoch: 'q12-b1#3',
          previousReached: 3,
          frameMs: 260000.04,
        }),
      ),
    ).toEqual({
      cueId: 'q12-b1#4',
      lateMs: 8.2,
      previousCueId: 'q12-b1#3',
      previousReached: 3,
      frameMs: 260000,
    })
  })

  it('has no bar before the first of a round', () => {
    const first = ringPromoteFields({
      epoch: 'q12-b1#0',
      lateMs: 0,
      previousEpoch: '',
      previousReached: -1,
      frameMs: 1,
    })
    expect(values(first)).toMatchObject({ previousCueId: '', previousReached: -1 })
  })
})
