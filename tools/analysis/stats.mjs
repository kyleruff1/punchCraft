// The few statistics the suites report.

const sorted = (values) => values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
const round1 = (v) => Math.round(v * 10) / 10

/**
 * Least, median, 95th percentile and most of a list of milliseconds; nulls
 * for an empty one. Anything that is not a finite number is left out.
 *
 * @param {unknown[]} values
 */
export function spread(values) {
  const v = sorted(values)
  if (v.length === 0) return { n: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null }
  return {
    n: v.length,
    minMs: round1(v[0]),
    medianMs: round1(v[Math.floor(v.length / 2)]),
    p95Ms: round1(v[Math.min(v.length - 1, Math.ceil(0.95 * v.length) - 1)]),
    maxMs: round1(v[v.length - 1]),
  }
}
