/**
 * Whether this build can find the gloves by itself.
 *
 * The tablet can: it scans, sees both trackers advertising, and connects.
 * A browser cannot. Web Bluetooth has no scan — a page may only ask for a
 * device from inside a click, and the browser shows its own chooser — so
 * every path that would start a scan (launch auto-connect, the retry loop,
 * the Connect and Fix buttons) has nothing to do there, and before this
 * existed they retried a scan that can never succeed.
 *
 * The PC app runs on simulated punches for now. When it gets a pairing
 * screen of its own (`tools/pc/glove-check` is the working model), that
 * screen replaces what this switches off; it does not flip this constant.
 */
import { Platform } from 'react-native'

export function canFindGloves(): boolean {
  return Platform.OS !== 'web'
}

/** What a connect pass reports where it cannot run. */
export const NO_GLOVE_SEARCH_MESSAGE = 'This version cannot search for the trackers.'
