/**
 * recordsWithTag — legacy log-code back-compat.
 *
 * Event codes were renamed `puncheokie.*` -> `workout.*` when the Puncheoke
 * instrument was forked out. Every capture recorded before that rename still
 * carries the old prefix, and those captures are the baselines the regression
 * comparisons rest on (the breath-floor A/B, the pre/post-floor suites).
 *
 * Without the alias the matcher returns ZERO rows on historical data — which
 * reads as "nothing happened in that run" rather than "the matcher no longer
 * speaks this capture's dialect". That silent-zero is the failure mode these
 * tests exist to prevent, so the control case matters as much as the happy one.
 */

const { recordsWithTag, recordTag, withCurrentTag } = require('../logcat.mjs')

// The real captures are logcat BRIEF format, copied verbatim from
// tools/analysis/suites/post-floor/body-work/logcat.txt:
//   09-08 09:33:27.080 I/ReactNativeJS(  816): '[INFO] <code>', '<msg>', { ... }
// Guessing threadtime format here produced a test that failed against code
// which demonstrably works on real data — the fixture has to match the wire.
const line = (time, code, level = 'INFO') =>
  `09-08 ${time} I/ReactNativeJS(  816): '[${level}] ${code}', 'msg', { a: 1 }`

const LEGACY_CAPTURE = [
  line('10:00:00.100', 'puncheokie.cue.tokenDue'),
  line('10:00:00.600', 'puncheokie.cue.tokenDue'),
  line('10:00:01.000', 'puncheokie.round.boundary'),
  line('10:00:01.500', 'puncheokie.cue.tokenDue.skipped'),
].join('\n')

const CURRENT_CAPTURE = [
  line('10:00:00.100', 'workout.cue.tokenDue'),
  line('10:00:01.000', 'workout.round.boundary'),
].join('\n')

describe('recordsWithTag legacy aliasing', () => {
  it('reads pre-rename captures under the current tag name', () => {
    expect(recordsWithTag(LEGACY_CAPTURE, 'workout.cue.tokenDue')).toHaveLength(2)
    expect(recordsWithTag(LEGACY_CAPTURE, 'workout.round.boundary')).toHaveLength(1)
  })

  it('still reads post-rename captures', () => {
    expect(recordsWithTag(CURRENT_CAPTURE, 'workout.cue.tokenDue')).toHaveLength(1)
    expect(recordsWithTag(CURRENT_CAPTURE, 'workout.round.boundary')).toHaveLength(1)
  })

  it('reads a mixed corpus — both dialects in one pass', () => {
    const mixed = `${LEGACY_CAPTURE}\n${CURRENT_CAPTURE}`
    expect(recordsWithTag(mixed, 'workout.cue.tokenDue')).toHaveLength(3)
  })

  it('stays EXACT — an alias never swallows a longer code', () => {
    // `.tokenDue` must not absorb `.tokenDue.skipped` in either dialect;
    // that would inflate every count silently.
    expect(recordsWithTag(LEGACY_CAPTURE, 'workout.cue.tokenDue')).toHaveLength(2)
    expect(recordsWithTag(LEGACY_CAPTURE, 'workout.cue.tokenDue.skipped')).toHaveLength(1)
  })

  it('does not alias tags outside the workout namespace', () => {
    const other = line('10:00:00.100', 'ble.scan.start')
    expect(recordsWithTag(other, 'ble.scan.start')).toHaveLength(1)
    // A non-workout tag gets no legacy twin invented for it.
    expect(recordsWithTag(other, 'workout.scan.start')).toHaveLength(0)
  })

  it('returns zero for a tag that appears in neither dialect', () => {
    // The control: proves a positive result above is real matching, not a
    // matcher that says yes to everything.
    expect(recordsWithTag(LEGACY_CAPTURE, 'workout.nonexistent.tag')).toHaveLength(0)
  })

  it('recordTag still parses the code out of a real record shape', () => {
    expect(recordTag("'[INFO] workout.cue.tokenDue', {}")).toBe('workout.cue.tokenDue')
    expect(recordTag("'[WARN] puncheokie.metronome', {}")).toBe('puncheokie.metronome')
  })
})

describe('withCurrentTag', () => {
  it('reads a pre-rename event code as it is spelled today', () => {
    expect(withCurrentTag("'[INFO] puncheokie.clickScript.dispatch', 'x', { kind: 'call',")).toBe(
      "'[INFO] workout.clickScript.dispatch', 'x', { kind: 'call',",
    )
    expect(withCurrentTag("'[WARN] puncheokie.voice.clipMissing', 'y', {}")).toBe(
      "'[WARN] workout.voice.clipMissing', 'y', {}",
    )
  })

  it('leaves a current code, and a code from another family, alone', () => {
    for (const body of ["'[INFO] workout.cue.tokenDue', {}", "'[INFO] ble.slot.connect.ok', {}"]) {
      expect(withCurrentTag(body)).toBe(body)
    }
  })

  it('rewrites only the code — the same word elsewhere in a record is content', () => {
    const body =
      "'[INFO] workout.qa.run', 'x', { route: '/(tabs)/puncheokie/jam', note: 'puncheokie.x' }"
    expect(withCurrentTag(body)).toBe(body)
    expect(withCurrentTag("  slot: 'puncheokie.cue'")).toBe("  slot: 'puncheokie.cue'")
  })
})
