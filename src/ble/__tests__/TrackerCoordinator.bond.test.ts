/**
 * The coordinator's part in recognising an unbonded glove (H13): it feeds
 * each slot's connection events to `bondDiagnosis` and publishes the verdict
 * to the tracker store. The timing rule itself is tested in
 * `bondDiagnosis.test.ts`; this is the wiring — which events count, and that
 * the verdict survives the slot being torn down between connects.
 */
import type { BleManagerFacade } from '../BleManagerFacade'
import type { ConnectionState, ConnectionStatus } from '../bleTypes'
import { UNBONDED_DROP_WINDOW_MS } from '../bondDiagnosis'
import { TrackerCoordinator } from '../TrackerCoordinator'
import { useTrackerStore } from '@/state/useTrackerStore'

const LEFT = 'D7:34:B4:27:D5:84'
const RIGHT = 'EA:69:2D:9C:FD:53'

function harness() {
  const listeners = new Map<string, Set<(s: ConnectionStatus) => void>>()
  let clock = 0
  let failNextConnect: Error | null = null
  const emit = (deviceId: string, state: ConnectionState): ConnectionStatus => {
    const status: ConnectionStatus = {
      deviceId,
      state,
      generation: 1,
      lastChangeMonotonicMs: clock,
    }
    for (const cb of [...(listeners.get(deviceId) ?? [])]) cb(status)
    return status
  }
  const facade = {
    onConnectionChange: (deviceId: string, cb: (s: ConnectionStatus) => void) => {
      const set = listeners.get(deviceId) ?? new Set()
      set.add(cb)
      listeners.set(deviceId, set)
      return () => set.delete(cb)
    },
    connect: async (deviceId: string) => {
      if (failNextConnect) {
        const err = failNextConnect
        failNextConnect = null
        emit(deviceId, 'error')
        throw err
      }
      return emit(deviceId, 'ready')
    },
    // Like the native transport: its own hang-up is reported as 'dormant'.
    disconnect: async (deviceId: string) => {
      emit(deviceId, 'dormant')
    },
    isConnected: async () => true,
  } as unknown as BleManagerFacade

  const coordinator = new TrackerCoordinator(facade)
  return {
    coordinator,
    /** Advance the transport's clock AND the timers, as real time would. */
    wait: (ms: number) => {
      clock += ms
      jest.advanceTimersByTime(ms)
    },
    drop: (deviceId: string, state: ConnectionState = 'dormant') => emit(deviceId, state),
    failNextConnect: (err: Error) => {
      failNextConnect = err
    },
    bond: () => useTrackerStore.getState().bond,
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  useTrackerStore.setState({
    slots: { left: null, right: null },
    bond: { left: 'unknown', right: 'unknown' },
  })
})

afterEach(() => {
  jest.useRealTimers()
})

describe('TrackerCoordinator — bond diagnosis', () => {
  it('is suspect after one drop at 37 s and probably unbonded after the second', async () => {
    const h = harness()
    await h.coordinator.connectSlot('left', LEFT)
    h.wait(37_000)
    h.drop(LEFT)
    expect(h.bond().left).toBe('suspect')

    // What auto-connect does next: evict the slot, then connect it afresh.
    await h.coordinator.evictSlot('left', LEFT)
    expect(useTrackerStore.getState().slots.left).toBeNull()
    expect(h.bond().left).toBe('suspect')

    h.wait(5_000)
    await h.coordinator.connectSlot('left', LEFT)
    h.wait(36_500)
    h.drop(LEFT)
    expect(h.bond()).toEqual({ left: 'probably-unbonded', right: 'unknown' })
  })

  it('says holding once the link outlives the window, without waiting for another event', async () => {
    const h = harness()
    await h.coordinator.connectSlot('left', LEFT)
    h.wait(UNBONDED_DROP_WINDOW_MS.max)
    expect(h.bond().left).toBe('unknown')
    h.wait(1)
    expect(h.bond().left).toBe('holding')
  })

  it('forgets an earlier drop once a link has held', async () => {
    const h = harness()
    await h.coordinator.connectSlot('left', LEFT)
    h.wait(37_000)
    h.drop(LEFT)
    await h.coordinator.connectSlot('left', LEFT)
    h.wait(120_000)
    expect(h.bond().left).toBe('holding')
    h.drop(LEFT)
    expect(h.bond().left).toBe('unknown')
    await h.coordinator.connectSlot('left', LEFT)
    h.wait(37_000)
    h.drop(LEFT)
    expect(h.bond().left).toBe('suspect')
  })

  it('does not count a hang-up of its own, even at 37 s', async () => {
    const h = harness()
    await h.coordinator.connectSlot('left', LEFT)
    h.wait(37_000)
    await h.coordinator.disconnectSlot('left')
    expect(h.bond().left).toBe('unknown')

    await h.coordinator.connectSlot('left', LEFT)
    h.wait(37_000)
    await h.coordinator.evictSlot('left', LEFT)
    expect(h.bond().left).toBe('unknown')
    // ...and no stale timer calls a dead link "holding".
    h.wait(60_000)
    expect(h.bond().left).toBe('unknown')
  })

  it('times the next link from its own start after a hang-up', async () => {
    const h = harness()
    await h.coordinator.connectSlot('left', LEFT)
    h.wait(10_000)
    await h.coordinator.disconnectSlot('left')
    h.wait(1_000)
    await h.coordinator.connectSlot('left', LEFT)
    // The first link's "it held" timer would be due now; it must be dead.
    h.wait(36_000)
    expect(h.bond().left).toBe('unknown')
    h.wait(1_000)
    h.drop(LEFT)
    // 37 s after THIS connect — not 48 s after the one that was hung up.
    expect(h.bond().left).toBe('suspect')
  })

  it('does not count a drop the transport reports as an error', async () => {
    const h = harness()
    await h.coordinator.connectSlot('left', LEFT)
    h.wait(37_000)
    h.drop(LEFT, 'error')
    expect(h.bond().left).toBe('unknown')
  })

  it('does not count a connect that never came up', async () => {
    const h = harness()
    h.failNextConnect(new Error('Device was disconnected'))
    await expect(h.coordinator.connectSlot('left', LEFT)).rejects.toThrow()
    h.wait(37_000)
    expect(h.bond().left).toBe('unknown')
  })

  it('judges each glove on its own', async () => {
    const h = harness()
    await h.coordinator.connectSlot('left', LEFT)
    await h.coordinator.connectSlot('right', RIGHT)
    h.wait(37_000)
    h.drop(RIGHT)
    h.wait(10_000)
    expect(h.bond()).toEqual({ left: 'holding', right: 'suspect' })
  })
})
