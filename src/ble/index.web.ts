/**
 * BLE bootstrap for the PC version. Metro picks this file over `index.ts`
 * for the web build, so the native BLE library — which looks up its native
 * module the moment it is imported, and throws when there is none — never
 * enters the browser's bundle.
 *
 * It registers the Web Bluetooth transport instead. Nothing in the PC app
 * asks it for a glove yet (`gloveSupport.ts`); it is here so that every
 * `getBleManager()` in the app gets a real transport that answers honestly —
 * no devices, no scan — rather than a stub the rest of the app could mistake
 * for a connected one.
 */
import { registerBleManagerFactory } from './BleManagerFacade'
import { BleManagerWebBluetoothImpl, type WebBluetooth } from './BleManagerWebBluetoothImpl'

/** The browser's own Bluetooth, or one that refuses when it has none. */
const bluetooth: WebBluetooth = (navigator as { bluetooth?: WebBluetooth }).bluetooth ?? {
  requestDevice: () => Promise.reject(new Error('this browser has no Web Bluetooth')),
  getAvailability: () => Promise.resolve(false),
}

registerBleManagerFactory(() => new BleManagerWebBluetoothImpl({ bluetooth }))

export { getBleManager } from './BleManagerFacade'
