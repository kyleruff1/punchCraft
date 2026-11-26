import { Link } from 'expo-router'
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { AMBIENT_LIMITS } from '@capture/ambientCapture'
import { getBuildInfo } from '@diagnostics/buildInfo'
import { useCaptureSettingsStore } from '@state/useCaptureSettingsStore'
import { useQaStore } from '@state/useQaStore'
import { colors } from '@/theme/colors'

/** Said in full, because this row is where the permission is actually given. */
export const QA_MODE_HINT =
  'Lets a punchcraft://qa/run link start a workout and throw simulated punches on its own. ' +
  'For the unattended timing suite. Leave it off otherwise.'

export const KEEP_RAW_FRAMES_HINT =
  'Stores every message the gloves send, before anything interprets it, so a workout can be ' +
  `re-read after the decoder changes. Old data is cleared after ${AMBIENT_LIMITS.retentionDays} days. ` +
  'Leave it on unless workouts start to stutter.'

export default function SettingsLanding() {
  const info = getBuildInfo()
  const qaEnabled = useQaStore((s) => s.enabled)
  const setQaEnabled = useQaStore((s) => s.setEnabled)
  const keepRawFrames = useCaptureSettingsStore((s) => s.keepRawFrames)
  const setKeepRawFrames = useCaptureSettingsStore((s) => s.setKeepRawFrames)
  const rows: Array<[string, string]> = [
    ['App name', info.appName],
    ['App version', info.appVersion],
    ['Git SHA', info.gitSha],
    ['Release channel', info.releaseChannel],
    ['Runtime version', info.runtimeVersion],
    ['Expo SDK', info.expoSdk],
    ['React Native', info.reactNative],
    ['Platform', info.platform],
    ['Platform version', String(info.platformVersion)],
    ['Android API level', info.androidApiLevel !== undefined ? String(info.androidApiLevel) : '-'],
    ['Bundle id', info.bundleId ?? '-'],
    ['Installation id', info.installationId ?? '-'],
  ]

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.container}>
      <Text style={styles.title}>Diagnostics</Text>
      <View style={styles.list}>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <Text style={styles.rowLabel}>{label}</Text>
            <Text style={styles.rowValue} selectable>
              {value}
            </Text>
          </View>
        ))}
      </View>
      <Link href="/settings/voice" asChild>
        <Pressable style={styles.linkButton} testID="voice-settings-link">
          <Text style={styles.linkButtonText}>Voice Coach</Text>
        </Pressable>
      </Link>
      <Link href="/settings/backdrop" asChild>
        <Pressable style={styles.linkButton} testID="backdrop-settings-link">
          <Text style={styles.linkButtonText}>Workout backdrop</Text>
        </Pressable>
      </Link>
      {/* QA mode is switched on HERE and nowhere else. A `qa/run` link can
          use it and can switch it off, but cannot switch it on: a URL anyone
          can open must not be able to grant itself the right to start a
          workout full of simulated punches (see `qa/run.tsx`). */}
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.rowLabel}>QA mode</Text>
          <Text style={styles.switchHint}>{QA_MODE_HINT}</Text>
        </View>
        <Switch
          accessibilityLabel="QA mode"
          onValueChange={setQaEnabled}
          testID="qa-mode-switch"
          value={qaEnabled}
        />
      </View>
      {/* Every glove frame is stored before anything decodes it (rule 1) —
          for the whole connection, not only inside Velocity Lab (N-7). The
          switch is the way back if those writes ever disturb a workout. */}
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.rowLabel}>Keep raw glove data</Text>
          <Text style={styles.switchHint}>{KEEP_RAW_FRAMES_HINT}</Text>
        </View>
        <Switch
          accessibilityLabel="Keep raw glove data"
          onValueChange={setKeepRawFrames}
          testID="keep-raw-frames-switch"
          value={keepRawFrames}
        />
      </View>
      <Link href="/(tabs)/velocity-lab" asChild>
        <Pressable style={styles.linkButton}>
          <Text style={styles.linkButtonText}>Back to Velocity Lab</Text>
        </Pressable>
      </Link>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  container: { padding: 20, gap: 16 },
  title: { fontSize: 24, fontWeight: '700', color: colors.textPrimary },
  list: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 12,
  },
  rowLabel: { fontSize: 14, fontWeight: '600', flexShrink: 0, color: colors.textPrimary },
  rowValue: { fontSize: 14, flexShrink: 1, textAlign: 'right', color: colors.textSecondary },
  linkButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  linkButtonText: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  switchText: { flex: 1, gap: 4 },
  switchHint: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
})
