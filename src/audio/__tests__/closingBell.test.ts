/**
 * The closing bell rings out.
 *
 * The last round ends on the same ding-ding as every other, and the screen
 * may then free its audio: the workout is over, so nothing holds it once the
 * athlete leaves — Exit, or "See summary". `release()` freed every player at
 * once, the bell among them. The bell is 1,180 ms long, so leaving within
 * about a second of it cut it off.
 *
 * The live screen does wait before it frees — `msUntilQuiet()` — but that
 * window is the coach's SPEECH. Bells are kept out of it on purpose (a bell
 * must never make the coach wait, GH #305), so for the closing bell the wait
 * read zero: the one sound it was written to protect was the one sound it
 * could not see.
 *
 * So the bell is spared by the teardown itself: `release()` frees everything
 * except a bell that is still ringing, and frees that when its ring ends.
 * And a bell still never blocks speech.
 */
import type { AudioPlayer } from 'expo-audio'

// The native audio modules need a binding this workstation does not have;
// every player here is injected.
jest.mock('expo-audio', () => ({
  createAudioPlayer: () => {
    throw new Error('expo-audio is not available in tests; inject createPlayer')
  },
  setAudioModeAsync: async () => undefined,
}))
jest.mock('expo-speech', () => ({ speak: () => {}, stop: () => {} }))

import { VoiceOutputExpo } from '../VoiceOutputExpo'

interface FakePlayer {
  duration: number
  volume: number
  currentTime: number
  plays: number
  seekTo: () => Promise<void>
  play: () => void
  pause: () => void
  remove: () => void
}

/** The bell clip's measured length. */
const BELL_MS = 1_180

function rig({ bellSeconds = BELL_MS / 1000 }: { bellSeconds?: number } = {}) {
  let now = 10_000
  const timers: { fn: () => void; atMs: number; cancelled: boolean }[] = []
  const made: FakePlayer[] = []
  const freed: FakePlayer[] = []
  const makeFake = (): AudioPlayer => {
    const player: FakePlayer = {
      duration: bellSeconds,
      volume: 1,
      currentTime: 0,
      plays: 0,
      seekTo: () => Promise.resolve(),
      play: () => {
        player.plays += 1
      },
      pause: () => {},
      remove: () => {
        freed.push(player)
      },
    }
    made.push(player)
    return player as unknown as AudioPlayer
  }
  const output = new VoiceOutputExpo({
    clock: () => now,
    schedule: (fn, delayMs) => {
      const timer = { fn, atMs: now + delayMs, cancelled: false }
      timers.push(timer)
      return timer
    },
    cancelScheduled: (handle) => {
      ;(handle as { cancelled: boolean }).cancelled = true
    },
    createPlayer: makeFake,
    createClickScriptPlayer: makeFake as never,
    setAudioMode: (async () => {}) as never,
  })
  return {
    output,
    made,
    freed,
    /** Move the clock on, firing every timer that falls due, in order. */
    advance(ms: number): void {
      const until = now + ms
      for (;;) {
        const due = timers
          .filter((t) => !t.cancelled && t.atMs <= until)
          .sort((a, b) => a.atMs - b.atMs)[0]
        if (!due) break
        now = Math.max(now, due.atMs)
        due.cancelled = true
        due.fn()
      }
      now = until
    },
    /** The player the bell is sounding on: the one that has been played. */
    bell(): FakePlayer {
      const ringing = made.filter((p) => p.plays > 0)
      expect(ringing).toHaveLength(1)
      return ringing[0] as FakePlayer
    },
  }
}

describe('a bell that is still ringing when the screen frees its audio', () => {
  it('is spared: everything else is freed at once, the bell when its ring ends', async () => {
    const h = rig()
    await h.output.preload({ light: true })
    const warmed = h.made.length
    expect(warmed).toBeGreaterThan(1)

    h.output.playAsset('bell')
    const bell = h.bell()
    // The athlete taps "See summary" a fifth of a second into the bell.
    h.advance(200)
    h.output.release()

    expect(h.freed).not.toContain(bell)
    expect(h.freed).toHaveLength(warmed - 1)

    // Still ringing a moment before its end…
    h.advance(BELL_MS - 200 - 1)
    expect(h.freed).not.toContain(bell)
    // …and freed once it has rung out. Nothing is left behind.
    h.advance(100)
    expect(h.freed).toContain(bell)
    expect(h.freed).toHaveLength(warmed)
  })

  it('is freed once, and only once, if the audio is freed again while it rings', async () => {
    // A blur and an unmount can both free: the screen's two teardown sites.
    const h = rig()
    await h.output.preload({ light: true })
    h.output.playAsset('bell')
    const bell = h.bell()
    h.advance(100)
    h.output.release()
    h.advance(100)
    h.output.release()
    expect(h.freed).not.toContain(bell)
    h.advance(BELL_MS)
    expect(h.freed.filter((p) => p === bell)).toHaveLength(1)
  })

  it('does not come back into the pool: a workout started meanwhile gets a bell of its own', async () => {
    const h = rig()
    await h.output.preload({ light: true })
    const warmed = h.made.length
    h.output.playAsset('bell')
    const old = h.bell()
    h.advance(100)
    h.output.release()

    // Back to the lobby while the old bell is still ringing out.
    await h.output.preload({ light: true })
    expect(h.made).toHaveLength(warmed * 2)
    h.advance(BELL_MS)
    // The old bell was freed; none of the new players was.
    expect(h.freed).toContain(old)
    expect(h.freed).toHaveLength(warmed)
  })
})

describe('a bell that is not ringing', () => {
  it('is freed with everything else once its ring has ended', async () => {
    const h = rig()
    await h.output.preload({ light: true })
    const warmed = h.made.length
    h.output.playAsset('bell')
    h.advance(BELL_MS + 1)
    h.output.release()
    expect(h.freed).toHaveLength(warmed)
  })

  it('is freed with everything else when it was never rung', async () => {
    const h = rig()
    await h.output.preload({ light: true })
    const warmed = h.made.length
    h.output.release()
    expect(h.freed).toHaveLength(warmed)
  })
})

describe('a bell whose length is not known yet', () => {
  it('is given long enough to ring out all the same', async () => {
    // A player reports a length of 0 until its clip has loaded.
    const h = rig({ bellSeconds: 0 })
    await h.output.preload({ light: true })
    h.output.playAsset('bell')
    const bell = h.bell()
    h.output.release()
    h.advance(BELL_MS)
    expect(h.freed).not.toContain(bell)
    h.advance(2_000)
    expect(h.freed).toContain(bell)
  })
})

describe('a bell still never blocks speech', () => {
  it('leaves the coach lane quiet: nothing waits on a bell', async () => {
    const h = rig()
    await h.output.preload({ light: true })
    h.output.playAsset('bell')
    expect(h.output.audibleUntilMs()).toBe(0)
    expect(h.output.msUntilQuiet()).toBe(0)
  })
})
