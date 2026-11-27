/**
 * Session history — every saved workout, newest first.
 *
 * A workout was saved from the day the engine could run one, and nothing in
 * the app ever showed it again. This is the list; a row opens the summary
 * (`summary?id=…`). Both read through `@storage/sessionHistory`, so a row
 * and the summary behind it cannot disagree.
 *
 * Three things a row says that a bare number would not:
 *
 * - **Stopped early**, when the athlete stopped the workout and kept it.
 * - **Simulated**, when the punches were — a simulated run is not training,
 *   and most of what a development tablet holds is exactly that.
 * - **matched punches**, instead of "punches", for a session saved before
 *   the live counts were kept: only punches that answered a called
 *   combination were stored then, so the number is not the whole count.
 */
import React, { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Link, Stack, useFocusEffect } from 'expo-router'

import { colors } from '@/theme/colors'
import { logger, safe } from '@diagnostics/logger'
import { formatSessionWhen, formatWorked } from '@domain/session/sessionDisplay'
import { getWorkoutPersistence } from '@storage/getWorkoutPersistence'
import { listSessionHistory, type SessionHistoryRow } from '@storage/sessionHistory'

export const EMPTY_HISTORY = 'No saved workouts yet. Finish one, or stop one and keep it.'
export const HISTORY_UNREADABLE = 'The saved workouts could not be read.'

/** "187 punches", or "187 matched punches" when that is all that was kept. */
export function punchesLabel(row: Pick<SessionHistoryRow, 'punches' | 'punchBasis'>): string {
  const noun = row.punches === 1 ? 'punch' : 'punches'
  return row.punchBasis === 'matched' ? `${row.punches} matched ${noun}` : `${row.punches} ${noun}`
}

function HistoryRow({ row }: { row: SessionHistoryRow }): React.JSX.Element {
  return (
    <Link href={{ pathname: '/(tabs)/punchcraft/summary', params: { id: row.sessionId } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.title}, ${formatSessionWhen(row.when)}`}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        testID={`history-row-${row.sessionId}`}
      >
        <View style={styles.rowHead}>
          <Text style={styles.rowTitle}>{row.title}</Text>
          {row.stopped ? (
            <Text style={styles.tag} testID="history-stopped">
              Stopped early
            </Text>
          ) : null}
          {row.simulated === true ? (
            <Text style={styles.tag} testID="history-simulated">
              Simulated
            </Text>
          ) : null}
        </View>
        <Text style={styles.rowDetail} testID="history-detail">
          {`${formatSessionWhen(row.when)} · ${formatWorked(row.activeDurationMs)} worked · ${punchesLabel(row)}`}
        </Text>
      </Pressable>
    </Link>
  )
}

export default function HistoryScreen(): React.JSX.Element {
  const [rows, setRows] = useState<SessionHistoryRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback((before?: number): void => {
    try {
      const page = listSessionHistory(
        getWorkoutPersistence(),
        before === undefined ? {} : { before },
      )
      setRows((shown) => (before === undefined ? page.rows : [...shown, ...page.rows]))
      setHasMore(page.hasMore)
      setFailed(false)
    } catch (err) {
      logger.error('workout.history.readFailed', 'the saved sessions could not be listed', {
        error: safe(String(err)),
      })
      setFailed(true)
    }
  }, [])

  // From the top each time the screen is shown: a workout may have been
  // saved, or a stopped one discarded, since it was last looked at.
  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  const last = rows[rows.length - 1]

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.container}
      testID="history-screen"
    >
      <Stack.Screen options={{ title: 'History' }} />
      {failed ? (
        <Text style={styles.empty} testID="history-failed" accessibilityRole="alert">
          {HISTORY_UNREADABLE}
        </Text>
      ) : rows.length === 0 ? (
        <Text style={styles.empty} testID="history-empty">
          {EMPTY_HISTORY}
        </Text>
      ) : (
        rows.map((row) => <HistoryRow key={row.sessionId} row={row} />)
      )}
      {hasMore && last ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => load(last.seq)}
          style={({ pressed }) => [styles.more, pressed && styles.rowPressed]}
          testID="history-more"
        >
          <Text style={styles.moreText}>Show older</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  container: { padding: 16, gap: 10, paddingBottom: 48 },
  empty: { fontSize: 16, lineHeight: 22, color: colors.textSecondary, padding: 4 },
  row: {
    gap: 4,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowPressed: { opacity: 0.7 },
  rowHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  rowTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  rowDetail: { fontSize: 13, color: colors.textSecondary },
  tag: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  more: {
    marginTop: 6,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
  },
  moreText: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
})
