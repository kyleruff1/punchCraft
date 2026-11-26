/**
 * Fix tracker connection — the last-resort reclaim.
 *
 * Tapping a badge already runs an auto-connect pass, which handles the
 * ordinary stale-slot case (D24). This button exists for the stuck-below-
 * the-app case: the OS holds a phantom GATT handle that survives every
 * app-side reset, and the only fix is a real adapter bounce. That is exactly
 * the incident the 2026-08-23 memory documents.
 *
 * Since Android 13 will not let us toggle the adapter from the app, the
 * button prompts the athlete: open Bluetooth settings, toggle it off then on,
 * we'll wait, and reconnect the trackers on the way back. The status line
 * says what to do next in every terminal state so nobody gets stuck
 * wondering what the button did.
 *
 * ## The other reason a glove will not hold: it is not paired (H13)
 *
 * A glove that is not bonded to the tablet drops 30-45 s after every
 * connect, and no bounce cures that — only pairing it does. When the bond
 * diagnosis says so (`src/ble/bondDiagnosis.ts`: two such drops in a row),
 * this button changes job while the glove is down: it says which glove and
 * why, and a tap opens Bluetooth settings to pair it — without then waiting
 * for a bounce that is not coming.
 */

import React, { useCallback, useState } from 'react'
import { Alert, Platform, StyleSheet, Text, View } from 'react-native'

import { bounceBluetoothAndReconnect, type BounceStatus } from '@ble/bounceBluetooth'
import { openBluetoothSettings } from '@ble/openBluetoothSettings'
import { ActionButton } from '@/components/branding/ActionButton'
import { glovesToPair, pairingHint } from '@components/bondAdvice'
import { useTrackerStore } from '@/state/useTrackerStore'
import { colors } from '@/theme/colors'

type Phase = 'idle' | 'waiting' | 'done'

interface Result {
  phase: Phase
  status?: BounceStatus
}

const HINT_FOR: Record<BounceStatus, string> = {
  ok: 'Bluetooth bounced and trackers reconnected.',
  'timed-out': 'Did not see Bluetooth turn off and back on in time. Try again.',
  'never-turned-off':
    'Bluetooth stayed on. Toggle it off in Settings and back on to clear the stuck connection.',
  'settings-unavailable':
    'Could not open Bluetooth settings automatically. Open Settings and toggle Bluetooth off and back on.',
  unauthorized: 'This app is not permitted to use Bluetooth. Grant the permission in Settings.',
}

const WAITING_LABEL = 'Waiting for Bluetooth bounce…'
const RETRY_LABEL = 'Try again'
const PAIR_MANUALLY =
  'Could not open Bluetooth settings automatically. Open Settings → Bluetooth → Pair new device and choose “FightCam”.'

export function FixTrackerButton(): React.ReactElement | null {
  // iOS has no per-panel Bluetooth settings intent and the ble-plx state
  // subscription behaves differently, so the flow does not apply. Rendering
  // nothing is honest: the button that promises to bounce Bluetooth cannot
  // deliver that on iOS today.
  const [result, setResult] = useState<Result>({ phase: 'idle' })
  const bond = useTrackerStore((s) => s.bond)
  const leftState = useTrackerStore((s) => s.slots.left?.state)
  const rightState = useTrackerStore((s) => s.slots.right?.state)
  const toPair = glovesToPair(bond, { left: leftState, right: rightState })
  const pairing = toPair.length > 0

  const onPress = useCallback(async () => {
    if (result.phase === 'waiting') return
    if (pairing) {
      // Pairing, not a bounce: open the panel and leave it at that.
      try {
        await openBluetoothSettings()
      } catch {
        Alert.alert('Pair the glove', PAIR_MANUALLY)
      }
      return
    }
    setResult({ phase: 'waiting' })
    const outcome = await bounceBluetoothAndReconnect({ openSettings: openBluetoothSettings })
    setResult({ phase: 'done', status: outcome.status })
    if (outcome.status !== 'ok') {
      // A quiet alert for the terminal states — the small message below the
      // button is easy to miss when the athlete is on the bag.
      Alert.alert('Fix tracker connection', HINT_FOR[outcome.status])
    }
  }, [result.phase, pairing])

  if (Platform.OS !== 'android') return null

  const statusLine =
    result.phase === 'waiting'
      ? WAITING_LABEL
      : result.phase === 'done' && result.status !== 'ok'
        ? RETRY_LABEL
        : null
  // While a glove needs pairing that is the one thing to say; the bounce's
  // leftover lines would only argue with it.
  const bounceStatus = pairing ? null : statusLine
  const bounceHint =
    !pairing && result.phase === 'done' && result.status ? HINT_FOR[result.status] : null

  return (
    <View style={styles.wrap}>
      {/* The chrome "fix" art is the button; transient state rides in the
          words underneath — §19.4 wants the state named, not only shaded. */}
      <ActionButton
        action="fixTrackers"
        onPress={() => {
          void onPress()
        }}
        disabled={result.phase === 'waiting'}
        height={FIX_BUTTON_HEIGHT}
        fit="pill"
        accessibilityHint={
          pairing
            ? 'Opens Bluetooth settings so you can pair the glove'
            : 'Opens Bluetooth settings so you can toggle it off and on, then reconnects the trackers'
        }
        testID="fix-tracker-connection"
      />
      {/* Absolute overlay: hints paint below the button without taking
          layout space, so they can never displace the tracker cluster. */}
      {pairing || bounceStatus || bounceHint ? (
        <View style={styles.hintOverlay} pointerEvents="none">
          {pairing ? (
            <Text style={[styles.hint, styles.pairHint]} testID="fix-tracker-pair-hint">
              {pairingHint(toPair)}
            </Text>
          ) : null}
          {bounceStatus ? (
            <Text style={styles.hint} testID="fix-tracker-status">
              {bounceStatus}
            </Text>
          ) : null}
          {bounceHint ? (
            <Text style={styles.hint} testID="fix-tracker-hint">
              {bounceHint}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

/** Matches ConnectTrackersButton's compact art height so the pair reads
 * as siblings in the badges row. */
const FIX_BUTTON_HEIGHT = 30

const styles = StyleSheet.create({
  wrap: { gap: 2, alignItems: 'center' },
  hintOverlay: {
    position: 'absolute',
    top: '100%',
    left: '50%',
    width: 320,
    marginLeft: -160,
    marginTop: 4,
    alignItems: 'center',
    gap: 2,
    zIndex: 20,
  },
  hint: {
    fontSize: 12,
    lineHeight: 16,
    color: colors.textSecondary,
    textAlign: 'center',
    maxWidth: 300,
  },
  pairHint: { color: colors.warning },
})
