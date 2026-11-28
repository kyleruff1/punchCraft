/**
 * The app's own playback observer against the audio elements: the same plays
 * timed two ways. The arithmetic that matters is the one subtraction the app
 * leaves to the suite — a browser shows the observer a clip some way in, and
 * "began" is its onset less the position it had reached.
 */
import { observerReport, renderObserver } from '../observer.mjs'

const observed = (fields, monoMs = 0) => ({
  wallMs: 0,
  monoMs,
  level: 'info',
  args: ['[INFO] workout.voice.observed', 'coach play observed', fields],
})
/** An element play: began, sounded, stopped. */
const element = (playingAtMs, stoppedAtMs, { heard = true } = {}) => ({
  playingAtMs,
  stoppedAtMs,
  sound: heard ? [{ startMs: playingAtMs + 70, endMs: stoppedAtMs - 20, peak: 0.4 }] : [],
})
const one = (playId, play) => ({ playId, first: play, last: play })
const call = (over) => ({
  playId: 'voice-1',
  kind: 'click-script',
  label: 'one two',
  outcome: 'ok',
  silentByVolume: false,
  ...over,
})

describe('observerReport', () => {
  it('takes the position first seen off the onset before comparing starts', () => {
    // The element began at 1 000. The observer first saw it 250 ms in, at 1 252.
    const report = observerReport(
      [observed(call({ onsetMs: 1_252, positionAtOnsetMs: 250, endMs: 1_901 }))],
      [one('voice-1', element(1_000, 1_900))],
    )
    expect(report.compared).toBe(1)
    expect(report.startMs).toMatchObject({ n: 1, medianMs: 2 })
    expect(report.endMs).toMatchObject({ n: 1, medianMs: 1 })
    expect(report.firstSeenMs).toMatchObject({ n: 1, medianMs: 250 })
  })

  it('a ceremony is held against its first clip’s start and its last clip’s end', () => {
    const first = element(5_000, 7_600)
    const last = element(7_950, 16_100)
    const report = observerReport(
      [
        observed({
          playId: 'warn-1',
          kind: 'round-warning',
          label: 'warn-round-2',
          outcome: 'ok',
          onsetMs: 5_240,
          positionAtOnsetMs: 243,
          endMs: 16_104,
        }),
      ],
      [{ playId: 'warn-1', first, last }],
    )
    expect(report.startMs.medianMs).toBe(-3)
    expect(report.endMs.medianMs).toBe(4)
  })

  it('compares an end only for a play the observer saw end by itself', () => {
    const report = observerReport(
      [
        observed(
          call({ outcome: 'superseded', onsetMs: 1_250, positionAtOnsetMs: 250, endMs: 1_400 }),
        ),
      ],
      [one('voice-1', element(1_000, 1_900))],
    )
    expect(report.outcomes).toEqual({ superseded: 1 })
    expect(report.startMs.n).toBe(1)
    expect(report.endMs.n).toBe(0)
  })

  it('names a play that sounded and the observer never saw start', () => {
    const report = observerReport(
      [observed(call({ outcome: 'timeout', onsetMs: null, positionAtOnsetMs: null, endMs: null }))],
      [one('voice-1', element(1_000, 1_900))],
    )
    expect(report.unseen).toEqual([
      { playId: 'voice-1', kind: 'click-script', label: 'one two', outcome: 'timeout' },
    ])
    expect(report.startMs.n).toBe(0)
  })

  it('names a play the observer saw start on an element that made no sound', () => {
    const report = observerReport(
      [observed(call({ onsetMs: 1_250, positionAtOnsetMs: 250, endMs: 1_900 }))],
      [one('voice-1', element(1_000, 1_900, { heard: false }))],
    )
    expect(report.unheard).toHaveLength(1)
  })

  it('does not call a clip ducked to volume 0 unheard — silence is what it is for', () => {
    const report = observerReport(
      [
        observed(
          call({ silentByVolume: true, onsetMs: 1_250, positionAtOnsetMs: 250, endMs: 1_900 }),
        ),
      ],
      [one('voice-1', element(1_000, 1_900, { heard: false }))],
    )
    expect(report.unheard).toEqual([])
  })

  it('counts by kind what it has no element to hold against', () => {
    const report = observerReport(
      [
        observed({ playId: 'metronome-1', kind: 'metronome', outcome: 'released', onsetMs: 10 }),
        observed(call({ playId: 'voice-9', onsetMs: 1_250, positionAtOnsetMs: 250, endMs: 1_900 })),
      ],
      [one('voice-9', null)],
    )
    expect(report.records).toBe(2)
    expect(report.compared).toBe(0)
    expect(report.notCompared).toEqual({ metronome: 1, 'click-script': 1 })
  })
})

describe('renderObserver', () => {
  it('says so when the app logged no observed plays', () => {
    expect(renderObserver(observerReport([], [])).join('\n')).toContain('no observed plays')
  })

  it('gives the three rows and lists what the two disagree about', () => {
    const text = renderObserver(
      observerReport(
        [
          observed(call({ onsetMs: 1_252, positionAtOnsetMs: 250, endMs: 1_901 })),
          observed(
            call({
              playId: 'voice-2',
              label: 'jab',
              outcome: 'timeout',
              onsetMs: null,
              endMs: null,
            }),
          ),
        ],
        [one('voice-1', element(1_000, 1_900)), one('voice-2', element(3_000, 3_400))],
      ),
    ).join('\n')
    expect(text).toContain('| began (onset less the position first seen) | 1 | 2 | 2 | 2 | 2 |')
    expect(text).toContain('| ended | 1 | 1 | 1 | 1 | 1 |')
    expect(text).toContain('1 ok, 1 timeout')
    expect(text).toContain('click-script “jab” (timeout)')
  })
})
