/**
 * The PC build's reading of a player's status (`observedStatus.web.ts`), on
 * its own and through the observer.
 *
 * The status sequences here are the ones expo-audio's browser players
 * actually emit — a `play` event at position 0, a `loadeddata` from a
 * swapped element, position reports about four times a second — because the
 * wrong-but-plausible alternative is exactly what the observer did before:
 * read them as the tablet's, call the request the onset, and call a clip
 * finished when its player loaded.
 *
 * `PlaybackObserver.test.ts` pins the tablet and is not touched by any of
 * this: with no reading, every status is read as it arrives.
 */
import { observedStatusReading as tabletReading } from '../observedStatus'
import { observedStatusReading as browserReading } from '../observedStatus.web'
import { PlaybackObserver, type ObservedRecord, type StatusLike } from '../PlaybackObserver'

const read = (status: StatusLike, started = false): readonly StatusLike[] => {
  if (browserReading === undefined) throw new Error('the PC build has no reading')
  return browserReading(status, started)
}

describe('the tablet build', () => {
  it('supplies no reading — the observer sees every status as it arrives', () => {
    expect(tabletReading).toBeUndefined()
  })
})

describe('reading a browser status before the play has its onset', () => {
  it('ignores the play event: playing is true and the playhead is at 0', () => {
    expect(read({ playing: true, currentTime: 0 })).toEqual([])
  })

  it('ignores a status from an element that has loaded and not moved', () => {
    expect(read({ playing: false, currentTime: 0, isLoaded: true })).toEqual([])
  })

  it('passes on a status once the playhead has moved', () => {
    const status = { playing: true, currentTime: 0.25 }
    expect(read(status)).toEqual([status])
  })

  it('reads a status that has moved and already stopped as a start and then that stop', () => {
    const status = { playing: false, didJustFinish: true, currentTime: 0.31 }
    expect(read(status)).toEqual([
      { playing: true, didJustFinish: false, currentTime: 0.31 },
      status,
    ])
  })

  it('ignores a playlist that says playing while its first track sits at 0', () => {
    expect(read({ playing: true, currentTime: 0, currentIndex: 0 })).toEqual([])
  })

  it('counts a playlist on a later track as moved — a track starts at 0', () => {
    const status = { playing: true, currentTime: 0, currentIndex: 1 }
    expect(read(status)).toEqual([status])
  })
})

describe('reading a browser status once the play has its onset', () => {
  it('passes everything on untouched — a stop is a stop wherever the playhead is', () => {
    const parked = { playing: false, currentTime: 0 }
    const trackChange = { playing: true, currentTime: 0, currentIndex: 2 }
    expect(read(parked, true)).toEqual([parked])
    expect(read(trackChange, true)).toEqual([trackChange])
  })
})

// --- through the observer ---------------------------------------------------

interface FakePlayer {
  addListener: (event: string, cb: (s: StatusLike) => void) => { remove: () => void }
  emit: (s: StatusLike) => void
}

function fakePlayer(): FakePlayer {
  let listeners: Array<(s: StatusLike) => void> = []
  return {
    addListener: (_event, cb) => {
      listeners.push(cb)
      return {
        remove: () => {
          listeners = listeners.filter((l) => l !== cb)
        },
      }
    },
    emit: (s) => {
      for (const l of [...listeners]) l(s)
    },
  }
}

function rig() {
  let now = 10_000
  let nextId = 1
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  const records: ObservedRecord[] = []
  const observer = new PlaybackObserver({
    clock: () => now,
    schedule: (fn, delayMs) => {
      const id = nextId++
      timers.push({ at: now + delayMs, fn, id })
      return id
    },
    cancelScheduled: (handle) => {
      const i = timers.findIndex((t) => t.id === handle)
      if (i >= 0) timers.splice(i, 1)
    },
    onObserved: (r) => records.push(r),
    readStatus: browserReading,
  })
  const advance = (ms: number): void => {
    now += ms
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at > now) break
      timers.splice(timers.indexOf(t), 1)
      t.fn()
    }
  }
  return { observer, records, advance }
}

const meta = (playId: string, expectedDurationMs = 900) => ({
  playId,
  kind: 'click-script' as const,
  label: 'one two',
  expectedDurationMs,
  dispatchMs: 10_000,
  volumeAtDispatch: 1,
  positionAtDispatchMs: 0,
})

describe('the observer in a browser', () => {
  it('a download-first clip: the request and the element swap are not its start and end', () => {
    const h = rig()
    const p = fakePlayer()
    h.observer.watch(p, meta('a'))

    // Asked to play, on an element with nothing to play yet.
    h.advance(1)
    p.emit({ playing: true, currentTime: 0 })
    // The clip arrives; the player swaps in a second element, which loads…
    h.advance(4)
    p.emit({ playing: false, currentTime: 0, isLoaded: true })
    // …and is asked to play in its turn.
    p.emit({ playing: true, currentTime: 0 })
    expect(h.records).toHaveLength(0)

    // Sound from 10 060. The browser's first position report is 250 ms in.
    h.advance(55 + 250)
    p.emit({ playing: true, currentTime: 0.25 })
    h.advance(650)
    p.emit({ playing: false, didJustFinish: true, currentTime: 0.9 })

    expect(h.records).toHaveLength(1)
    const [record] = h.records
    expect(record).toMatchObject({
      playId: 'a',
      outcome: 'ok',
      onsetMs: 10_310,
      positionAtOnsetMs: 250,
      endMs: 10_960,
    })
    // What the PC suite does with it: the sound began at the onset less the
    // position the playhead had already reached.
    expect((record?.onsetMs ?? 0) - (record?.positionAtOnsetMs ?? 0)).toBe(10_060)
  })

  it('a clip shorter than the gap between position reports is still seen to start and end', () => {
    const h = rig()
    const p = fakePlayer()
    h.observer.watch(p, meta('short', 180))
    p.emit({ playing: true, currentTime: 0 })

    h.advance(240)
    p.emit({ playing: false, didJustFinish: true, currentTime: 0.18 })

    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({
      outcome: 'ok',
      onsetMs: 10_240,
      positionAtOnsetMs: 180,
      endMs: 10_240,
    })
  })

  it('a play whose playhead never moves is a timeout with no onset, not a 4 ms clip', () => {
    const h = rig()
    const p = fakePlayer()
    h.observer.watch(p, meta('stuck'))
    p.emit({ playing: true, currentTime: 0 })
    h.advance(4)
    p.emit({ playing: false, currentTime: 0, isLoaded: true })
    expect(h.records).toHaveLength(0)

    h.advance(4_000)
    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({ outcome: 'timeout', onsetMs: null, endMs: null })
  })

  it('a clip stopped and parked at 0 after it began closes at the stop', () => {
    const h = rig()
    const p = fakePlayer()
    h.observer.watch(p, meta('stopped'))
    h.advance(300)
    p.emit({ playing: true, currentTime: 0.25 })
    h.advance(200)
    p.emit({ playing: false, currentTime: 0 })

    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({ outcome: 'ok', onsetMs: 10_300, endMs: 10_500 })
  })

  it('a playlist: says playing from the request, starts when its first track moves', () => {
    const h = rig()
    const p = fakePlayer()
    h.observer.watch(p, { ...meta('ceremony', 3_000), kind: 'round-warning' as const })

    // Every status a browser playlist sends says playing once play() is called.
    p.emit({ playing: true, currentTime: 0, currentIndex: 0 })
    h.advance(20)
    p.emit({ playing: true, currentTime: 0, currentIndex: 0, isLoaded: true })
    h.advance(280)
    p.emit({ playing: true, currentTime: 0.25, currentIndex: 0 })
    // The second track starts at 0 — progress, as on the tablet.
    h.advance(1_200)
    p.emit({ playing: true, currentTime: 0, currentIndex: 1 })
    h.advance(1_500)
    p.emit({ playing: false, didJustFinish: true, currentTime: 1.5, currentIndex: 1 })

    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toMatchObject({
      outcome: 'ok',
      onsetMs: 10_300,
      positionAtOnsetMs: 250,
      endMs: 13_000,
    })
  })
})
