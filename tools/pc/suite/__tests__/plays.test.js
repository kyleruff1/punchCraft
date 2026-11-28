/**
 * Which clip an element played, and why it stopped. Both answers decide
 * whether the sound gate fails a drive, so both are pinned here.
 */
import { APP_STOP_WINDOW_MS, appStopTimes, clipKind, clipName, stopReasonOf } from '../plays.mjs'

describe('clipKind', () => {
  // File names as the tap recorded them on 2026-11-27, with the build's hash.
  const hashed = (name) => `${name}.0123456789abcdef0123456789abcdef.wav`

  it('names the build’s own clips from their files', () => {
    expect(clipKind(hashed('bell'))).toBe('bell')
    expect(clipKind(hashed('silence-350'))).toBe('silence')
    expect(clipKind(hashed('intro-hello'))).toBe('intro')
    expect(clipKind(hashed('intro-program-intermediate-steady'))).toBe('intro')
    expect(clipKind(hashed('warn-opener-15'))).toBe('countdown')
    expect(clipKind(hashed('warn-round-2'))).toBe('countdown')
    expect(clipKind(hashed('rr-3658e672'))).toBe('rest-line')
    expect(clipKind(hashed('li-2ba7c178'))).toBe('lead-in')
  })

  it('knows a downloaded clip by the id it has where a name would be', () => {
    expect(clipKind('3f2a9c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f')).toBe('downloaded')
  })

  it('knows the element a download-first player starts on: it has no source at all', () => {
    expect(clipKind('')).toBe('phantom')
    expect(clipKind(undefined)).toBe('phantom')
  })

  it('does not guess at a file it has no name for', () => {
    expect(clipKind('call.wav')).toBe('other')
    expect(clipKind(hashed('bellows'))).toBe('other')
    expect(clipName(hashed('warn-round-2'))).toBe('warn-round-2')
  })
})

describe('stopReasonOf', () => {
  const play = (over = {}) => ({
    id: 1,
    playAtMs: 1_000,
    durationMs: 1_000,
    sound: [],
    stoppedBy: 'pause',
    stoppedAtMs: 2_000,
    stoppedPositionMs: 1_000,
    ...over,
  })
  const reason = (over, appStops = []) => stopReasonOf(play(over), { appStops, truncationMs: 150 })

  it('ended: the playhead was at the clip’s end, to within the allowance', () => {
    expect(reason({})).toBe('ended')
    expect(reason({ stoppedPositionMs: 850 })).toBe('ended')
  })

  it('unexplained: short of its end and nothing says why — a cut', () => {
    expect(reason({ stoppedPositionMs: 849 })).toBe('unexplained')
    expect(reason({ stoppedBy: 'emptied', stoppedPositionMs: 0 })).toBe('unexplained')
  })

  it('app-stopped: short of its end at a moment the app logged stopping it', () => {
    expect(reason({ stoppedPositionMs: 300 }, [2_000 + APP_STOP_WINDOW_MS])).toBe('app-stopped')
    expect(reason({ stoppedPositionMs: 300 }, [2_000 + APP_STOP_WINDOW_MS + 1])).toBe('unexplained')
  })

  it('run-ended: it had not stopped when the capture did', () => {
    expect(reason({ stoppedBy: null, stoppedAtMs: null, stoppedPositionMs: null })).toBe(
      'run-ended',
    )
  })

  it('replayed: its own element was played again before it finished', () => {
    expect(reason({ stoppedBy: 'replayed', stoppedPositionMs: 400 })).toBe('replayed')
    // Played again after it had finished is just the next play.
    expect(reason({ stoppedBy: 'replayed', stoppedPositionMs: 1_000 })).toBe('ended')
  })

  it('unknown: it stopped, and its length was never reported', () => {
    expect(reason({ durationMs: null })).toBe('unknown')
  })

  it('reads the app’s own “stopped” lines, and only those', () => {
    const line = (code, message, monoMs) => ({
      wallMs: 0,
      monoMs,
      level: 'info',
      args: [`[INFO] ${code}`, message, {}],
    })
    const records = [
      line('workout.warn', 'round warning stopped', 60_014),
      line('workout.recovery', 'recovery stopped', 60_015),
      line('workout.intro', 'intro stopped', 5),
      line('workout.warn', 'round warning playing', 42_603),
      line('workout.intro', 'intro complete', -1),
    ]
    expect(appStopTimes(records)).toEqual([60_014, 60_015, 5])
  })
})
