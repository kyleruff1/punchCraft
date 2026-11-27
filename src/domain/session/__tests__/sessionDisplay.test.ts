import { formatSessionWhen, formatWorked } from '../sessionDisplay'

describe('formatSessionWhen', () => {
  // Built from local parts, so the expectation holds in any time zone.
  const at = (y: number, m: number, d: number, h: number, min: number): string =>
    new Date(y, m, d, h, min).toISOString()

  it('writes the date and time in the device’s own zone', () => {
    expect(formatSessionWhen(at(2026, 10, 26, 15, 7))).toBe('26 Nov 2026, 15:07')
    expect(formatSessionWhen(at(2027, 0, 3, 0, 0))).toBe('3 Jan 2027, 00:00')
  })

  it('hands back what it was given when that is not a date', () => {
    expect(formatSessionWhen('not a date')).toBe('not a date')
    expect(formatSessionWhen('')).toBe('')
  })
})

describe('formatWorked', () => {
  it('writes minutes and seconds', () => {
    expect(formatWorked(0)).toBe('0:00')
    expect(formatWorked(59_400)).toBe('0:59')
    expect(formatWorked(60_000)).toBe('1:00')
    expect(formatWorked(760_000)).toBe('12:40')
    expect(formatWorked(3_725_000)).toBe('62:05')
  })

  it('does not go below zero', () => {
    expect(formatWorked(-5_000)).toBe('0:00')
  })
})
