/**
 * Build-info collector used by the Settings > Diagnostics screen (spec §22
 * Phase 0 task 9, story M02-06). Values come from Expo Constants and from
 * the compile-time `extra.gitSha` field written by app.config.ts.
 */
import Constants from 'expo-constants'
import { Platform } from 'react-native'
import rnPackage from 'react-native/package.json'

import { describeDevice } from './deviceKind'

export interface BuildInfo {
  appName: string
  appVersion: string
  gitSha: string
  releaseChannel: string
  runtimeVersion: string
  expoSdk: string
  reactNative: string
  platform: string
  platformVersion: string | number
  /** `Build.MODEL` on Android — what the device calls itself. */
  deviceModel?: string
  /** An Android emulator. Its captures are the PC's, not the tablet's (`deviceKind.ts`). */
  emulator: boolean
  androidApiLevel?: number
  bundleId?: string
  installationId?: string
}

export function getBuildInfo(): BuildInfo {
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>
  const device = describeDevice(Platform.OS, Platform.constants)
  return {
    appName: (Constants.expoConfig?.name as string) ?? 'punchCraft',
    appVersion: (Constants.expoConfig?.version as string) ?? '0.0.0',
    gitSha: (extra.gitSha as string | undefined) ?? 'unknown',
    releaseChannel: (extra.releaseChannel as string | undefined) ?? 'unknown',
    runtimeVersion: (Constants.expoConfig?.runtimeVersion as string | undefined) ?? 'unknown',
    expoSdk: (Constants.expoConfig?.sdkVersion as string | undefined) ?? 'unknown',
    reactNative: rnPackage.version ?? 'unknown',
    platform: Platform.OS,
    platformVersion: Platform.Version,
    deviceModel: device.deviceModel,
    emulator: device.emulator,
    androidApiLevel: Platform.OS === 'android' ? Number(Platform.Version) : undefined,
    bundleId: Constants.expoConfig?.android?.package,
    installationId: Constants.sessionId,
  }
}
