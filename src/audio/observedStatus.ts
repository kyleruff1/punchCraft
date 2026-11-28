/**
 * How this build reads a player's status for the timing observer.
 *
 * On the tablet: as it arrives. media3 flips `playing` in the pass that
 * starts the renderers, which is the signal `PlaybackObserver` was built on
 * and every tablet timing figure was measured against — so there is no
 * reading here, and the observer runs exactly as it did before this file
 * existed. Metro picks `observedStatus.web.ts` for the PC build.
 */
import type { StatusReading } from './PlaybackObserver'

export const observedStatusReading: StatusReading | undefined = undefined
