/**
 * TrackerScanner — bounded scan wrapper.
 *
 * Consumes only the BleManagerFacade surface (§11.4, §15.1). Accumulates
 * advertisements delivered during a bounded scan window and returns them
 * deduplicated by deviceId. On duplicates, keeps the LATEST rssi,
 * monotonicTimeMs, wallTimeIso, and serviceUuids, and merges manufacturer
 * data when the newer frame omits it.
 */
import type { BleManagerFacade, ScanOptions } from './BleManagerFacade'
import type { AdvertisementSnapshot } from './bleTypes'

export interface TrackerScannerRunOptions {
  timeoutMs?: number
  serviceUuids?: string[]
  stopAfterDevices?: number
}

const DEFAULT_TIMEOUT_MS = 12_000

export class TrackerScanner {
  constructor(private readonly facade: BleManagerFacade) {}

  async run(options: TrackerScannerRunOptions): Promise<AdvertisementSnapshot[]> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const stopAfterDevices = options.stopAfterDevices
    const byDevice = new Map<string, AdvertisementSnapshot>()

    let stopped = false
    const requestStop = (): void => {
      if (stopped) return
      stopped = true
      // Fire-and-forget: causes the in-flight scan() promise to resolve.
      // The `try` is for a transport that throws rather than rejects — this
      // runs from a timer, where a throw has nobody to catch it.
      try {
        void this.facade.stopScan().catch(() => {
          // Idempotent; swallow.
        })
      } catch {
        // Nothing to stop.
      }
    }

    const onAdvertisement = (ad: AdvertisementSnapshot): void => {
      const prev = byDevice.get(ad.deviceId)
      if (prev) {
        const merged: AdvertisementSnapshot = {
          deviceId: ad.deviceId,
          name: ad.name ?? prev.name,
          rssi: ad.rssi ?? prev.rssi,
          serviceUuids:
            ad.serviceUuids && ad.serviceUuids.length > 0 ? ad.serviceUuids : prev.serviceUuids,
          manufacturerDataBase64: ad.manufacturerDataBase64 ?? prev.manufacturerDataBase64,
          monotonicTimeMs: ad.monotonicTimeMs,
          wallTimeIso: ad.wallTimeIso,
        }
        byDevice.set(ad.deviceId, merged)
      } else {
        byDevice.set(ad.deviceId, ad)
      }
      if (stopAfterDevices !== undefined && byDevice.size >= stopAfterDevices) {
        requestStop()
      }
    }

    const scanOptions: ScanOptions = {
      timeoutMs,
      serviceUuids: options.serviceUuids,
      stopAfterDevices,
    }

    const timeoutHandle = setTimeout(requestStop, timeoutMs)

    try {
      // The scan resolves when it actually terminates — on its own, or
      // because `requestStop` called stopScan().
      //
      // The call itself is inside the `try` (N-9). It used to sit just above
      // it, so a transport whose `scan` THREW rather than rejected skipped
      // the handler below, left the stop timer armed, and had it fire into
      // `stopScan()` ten seconds later with nothing to catch it. The tablet's
      // transport returns a promise, so this only ever happened under a test
      // double — where it printed an uncaught error in the middle of every
      // full, green jest run.
      await this.facade.scan(scanOptions, onAdvertisement)
    } catch {
      // A failed scan yields an empty result rather than propagating.
      clearTimeout(timeoutHandle)
      try {
        await this.facade.stopScan()
      } catch {
        // Idempotent; swallow.
      }
      return []
    }

    clearTimeout(timeoutHandle)
    try {
      await this.facade.stopScan()
    } catch {
      // Idempotent; swallow.
    }

    return Array.from(byDevice.values()).sort((a, b) => b.monotonicTimeMs - a.monotonicTimeMs)
  }
}
