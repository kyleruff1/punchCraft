/**
 * How a saved session's time and length are written out.
 *
 * Wall time, and only for display: nothing orders or times anything by it
 * (spec §3.2). Written by hand rather than through `Intl`, whose output
 * depends on the locale data a given JavaScript engine happens to ship.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const two = (n: number): string => String(n).padStart(2, '0')

/** "26 Nov 2026, 15:07", in the device's own time zone. */
export function formatSessionWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const month = MONTHS[date.getMonth()] ?? ''
  return `${date.getDate()} ${month} ${date.getFullYear()}, ${two(date.getHours())}:${two(date.getMinutes())}`
}

/** Time worked, as minutes and seconds: "12:40". Rests and pauses are not in it. */
export function formatWorked(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${two(seconds % 60)}`
}
