/**
 * Workout Recipe screen (M31-06, doc §8).
 *
 * Lives under punchCraft, which owns building and running a workout end
 * to end. Scoring is punch count, not per-combo sequence grade.
 *
 * ## Collapse-first layout
 *
 * Every preference here sits behind a `PickerRow` (single-select) or a
 * `MultiPickerRow` (multi-select). Collapsed rows show the current value
 * so the athlete reads the whole recipe at a glance; only the picker the
 * athlete is actively touching expands, and only one at a time —
 * enforced by the `PickerProvider` wrapping the screen. That is what
 * keeps the whole recipe on one screen without scrolling in landscape
 * or portrait (the fit target Kyle set).
 */
import React, { useDeferredValue, useMemo } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Link, Stack } from 'expo-router'

import { ConflictNotice } from '@components/workout/ConflictNotice'
import { EnablementMenu } from '@components/workout/EnablementMenu'
import { ActionButton } from '@components/branding/ActionButton'
import { ForgedButton } from '@components/branding/ForgedButton'
import { RecipeSummaryCard } from '@components/workout/RecipeSummaryCard'
import { Stepper } from '@components/workout/RecipeControls'
import { CollapsibleSection } from '@components/ui/CollapsibleSection'
import { PickerProvider } from '@components/ui/PickerContext'
import { PickerRow, type PickerOption } from '@components/ui/PickerRow'
import { colors } from '@/theme/colors'
import { fonts, sizes } from '@/theme/typography'
import {
  conflictsForField,
  useConflicts,
  useRecipe,
  useRecipeSummary,
  useSelectedSampleKey,
  useWorkoutStore,
} from '@state/useWorkoutStore'
import {
  GOAL_MAX,
  GOAL_STEP,
  GOAL_TIERS,
  TIER_LABELS,
  intensityLabel,
  rescaleGoalForDuration,
  suggestGoal,
  type IntensityTier,
} from '@domain/workout/punchGoals'
import { coverageConflict } from '@domain/workout/coverageConflict'
import { generateWorkout } from '@domain/workout/generateWorkout'
import { canGenerate } from '@domain/workout/recipeValidation'
import { fillOptionsForRecipe } from '@audio/fillOptionsForRecipe'
import { listSampleWorkouts, type SampleWorkoutKey } from '@domain/workout/samples'
import { tierFor } from '@domain/workout/WorkoutRecipe'
import type { WorkoutRecipe } from '@domain/workout/WorkoutRecipe'
import type { WorkoutDurationMinutes } from '@domain/workout/roundSchedule'

// ---------------------------------------------------------------------------
// Option tables — kept as data so the screen body stays readable.
// ---------------------------------------------------------------------------

const DURATION_OPTIONS: ReadonlyArray<PickerOption<`${WorkoutDurationMinutes}`>> = [
  { value: '20', label: '20 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '40', label: '40 minutes' },
  { value: '60', label: '60 minutes' },
]

const TIER_OPTIONS: ReadonlyArray<PickerOption<'beginner' | 'intermediate' | 'advanced'>> = [
  {
    value: 'beginner',
    label: 'Beginner',
    description: 'Fundamentals — the core punches and simple ladders.',
  },
  {
    value: 'intermediate',
    label: 'Intermediate',
    description: 'Adds combinations, defense, and mid-length build-ups.',
  },
  {
    value: 'advanced',
    label: 'Advanced',
    description: 'Chains multi-phase patterns and defensive counters.',
  },
]

const FOCUS_OPTIONS: ReadonlyArray<PickerOption<WorkoutRecipe['focus']>> = [
  { value: 'hands', label: 'Hands', description: 'Punch-forward, less footwork.' },
  {
    value: 'movement',
    label: 'Movement',
    description: 'Lowers punch target for footwork and defense.',
  },
  { value: 'balanced', label: 'Balanced', description: 'Middle ground on punch density.' },
]

type StanceChoice = 'orthodox' | 'southpaw' | 'switch-by-round' | 'switch-on-command'

const STANCE_OPTIONS: ReadonlyArray<PickerOption<StanceChoice>> = [
  { value: 'orthodox', label: 'Orthodox', description: 'Left foot forward, right hand rear.' },
  { value: 'southpaw', label: 'Southpaw', description: 'Right foot forward, left hand rear.' },
  { value: 'switch-by-round', label: 'Switch by round' },
  { value: 'switch-on-command', label: 'Switch on command' },
]

const BIAS_OPTIONS: ReadonlyArray<PickerOption<WorkoutRecipe['bias']>> = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'lead', label: 'Lead hand', description: 'Follows the stance.' },
  { value: 'rear', label: 'Rear hand', description: 'Follows the stance.' },
  { value: 'left', label: 'Physical left', description: 'Fixed to the left arm.' },
  { value: 'right', label: 'Physical right', description: 'Fixed to the right arm.' },
]

const VOICE_MODE_OPTIONS: ReadonlyArray<PickerOption<WorkoutRecipe['voiceMode']>> = [
  { value: 'off', label: 'Off' },
  // What each mode does, per `shouldSpeak` in VoiceCoachPolicy. Minimal used
  // to read "Cue calls only." — the exact opposite: punch calls are the one
  // thing it drops.
  {
    value: 'minimal',
    label: 'Minimal',
    description: 'Bells, stance changes and the countdown. No punch calls.',
  },
  { value: 'standard', label: 'Standard', description: 'Punch calls, bells and round summaries.' },
  // Full adds coaching reminders over Standard. No workout schedules one
  // yet, so today the two sound the same — say so rather than promise more.
  { value: 'full', label: 'Full', description: 'Standard, plus coaching reminders (none yet).' },
]

const VOICE_VOCABULARY_OPTIONS: ReadonlyArray<PickerOption<WorkoutRecipe['voiceVocabulary']>> = [
  { value: 'numbers', label: 'Numbers', description: 'One, two, three…' },
  { value: 'names', label: 'Names', description: 'Jab, cross, hook…' },
]

const PLAN_OPTIONS: ReadonlyArray<PickerOption<WorkoutRecipe['adaptationMode']>> = [
  { value: 'fixed', label: 'Fixed', description: 'The recipe is the plan.' },
  { value: 'adaptive', label: 'Adaptive', description: 'Adjusts density at block boundaries.' },
  { value: 'goal-seeking', label: 'Goal-seeking', description: 'Also chases the punch target.' },
]

const TIER_ORDER: IntensityTier[] = ['technique', 'steady', 'hard', 'high-volume', 'extreme']

const INTENSITY_TIER_OPTIONS: ReadonlyArray<PickerOption<IntensityTier>> = TIER_ORDER.map(
  (tier) => ({
    value: tier,
    label: TIER_LABELS[tier],
  }),
)

function stanceChoiceFor(recipe: WorkoutRecipe): StanceChoice {
  if (recipe.stanceMode === 'switch-by-round') return 'switch-by-round'
  if (recipe.stanceMode === 'switch-on-command') return 'switch-on-command'
  return recipe.defaultStance
}

function patchForStanceChoice(choice: StanceChoice): Partial<WorkoutRecipe> {
  if (choice === 'orthodox' || choice === 'southpaw') {
    return { defaultStance: choice, stanceMode: 'fixed' }
  }
  return { stanceMode: choice }
}

// ---------------------------------------------------------------------------

export default function RecipeScreen(): React.JSX.Element {
  const recipe = useRecipe()
  const conflicts = useConflicts()
  const summary = useRecipeSummary()
  const selectedSampleKey = useSelectedSampleKey()
  const setRecipe = useWorkoutStore((s) => s.setRecipe)
  const selectSample = useWorkoutStore((s) => s.selectSample)
  const resetRecipe = useWorkoutStore((s) => s.resetRecipe)

  const samples = useMemo(() => listSampleWorkouts(), [])
  const intensity = intensityLabel(recipe.totalPunchGoal, recipe.durationMinutes)
  const suggested = suggestGoal(recipe.durationMinutes, 'steady', recipe.focus)

  // Does the workout this recipe would GENERATE actually fill its rounds?
  // `validateRecipe` cannot say — that takes the generator, run with the same
  // device-side options the live screen runs it with. With too narrow a set
  // of punches, or combinations capped very short, the answer is no: the
  // coach goes quiet for the last stretch of a round, and until now the
  // athlete found that out on the bag.
  //
  // Deferred, so a run of stepper taps is never held up by a generation; and
  // skipped when a library workout is picked, since the recipe is not what
  // runs then. A generator fault must not take the recipe screen with it.
  const deferredRecipe = useDeferredValue(recipe)
  const dryRounds = useMemo(() => {
    if (selectedSampleKey) return null
    try {
      return coverageConflict(generateWorkout(deferredRecipe, fillOptionsForRecipe(deferredRecipe)))
    } catch {
      return null
    }
  }, [deferredRecipe, selectedSampleKey])
  const allConflicts = useMemo(
    () => (dryRounds ? [...conflicts, dryRounds] : conflicts),
    [conflicts, dryRounds],
  )

  // An error is a recipe there is no workout for — no punches enabled, or
  // punches that form no combination — and until 2026-11-25 Start took the
  // athlete to the live screen regardless, to stand in front of empty rounds.
  // Start is now off while one stands, with the reason under it.
  //
  // Not when a library workout is picked: the recipe is not what runs then.
  // `dryRounds` follows a deferred recipe, so for the frame or two after an
  // edit this reflects the recipe as it was a moment ago.
  const startBlocked = !selectedSampleKey && !canGenerate(allConflicts)
  const blockers = startBlocked ? allConflicts.filter((c) => c.severity === 'error') : []

  // Conflicts already shown next to a control are not repeated in the card,
  // so the athlete reads each problem once, where they can act on it.
  const goalConflicts = conflictsForField(allConflicts, 'totalPunchGoal')

  const sampleOptions: ReadonlyArray<PickerOption<string | 'none'>> = useMemo(
    () => [
      { value: 'none' as const, label: 'None — build my own' },
      ...samples.map((s) => ({
        value: s.key,
        label: s.name,
        description: s.description,
      })),
    ],
    [samples],
  )

  return (
    <PickerProvider>
      <ScrollView style={styles.root} contentContainerStyle={styles.container}>
        <Stack.Screen options={{ title: 'Workout recipe' }} />

        <Text style={styles.intro}>
          Shape the workout — the coach generates the combinations; you are scored on punch count.
        </Text>

        {/* 1 — Duration */}
        <PickerRow
          id="duration"
          testID="duration"
          label="Duration"
          value={`${recipe.durationMinutes}` as `${WorkoutDurationMinutes}`}
          options={DURATION_OPTIONS}
          onChange={(value) => {
            // Carry the intensity across, not the number. A goal only means
            // something against a duration; keeping 900 punches while going
            // from 20 to 60 minutes silently drops the athlete from Steady to
            // below Technique, and leaves rounds the generator cannot fill.
            const durationMinutes = Number(value) as WorkoutDurationMinutes
            setRecipe({
              durationMinutes,
              totalPunchGoal: rescaleGoalForDuration(
                recipe.totalPunchGoal,
                recipe.durationMinutes,
                durationMinutes,
              ),
            })
          }}
        />

        {/* 2 — Punch goal (tier band picker + fine stepper in the popout) */}
        <PickerRow
          id="goal"
          testID="goal"
          label="Punch goal"
          caption={`Suggested for this duration and focus: ${suggested.toLocaleString('en-US')}.`}
          value={intensity.tier}
          options={INTENSITY_TIER_OPTIONS}
          valuePreview={`${recipe.totalPunchGoal.toLocaleString('en-US')} · ${intensity.label}`}
          onChange={(tier) =>
            setRecipe({ totalPunchGoal: GOAL_TIERS[tier][recipe.durationMinutes] })
          }
          extraBody={
            <View style={styles.goalExtras}>
              <Stepper
                testID="goal-stepper"
                value={recipe.totalPunchGoal}
                step={GOAL_STEP}
                min={GOAL_STEP}
                max={GOAL_MAX}
                format={(v) => v.toLocaleString('en-US')}
                onChange={(totalPunchGoal) => setRecipe({ totalPunchGoal })}
              />
              {intensity.warning ? (
                <View style={styles.extremeWarning} testID="extreme-warning">
                  <View style={styles.warningIconBox}>
                    <Text style={styles.warningIcon}>!</Text>
                  </View>
                  <Text style={styles.extremeWarningText}>{intensity.warning}</Text>
                </View>
              ) : null}
              {goalConflicts.map((conflict) => (
                <ConflictNotice key={conflict.code} conflict={conflict} />
              ))}
            </View>
          }
        />

        {/* 3 — Tier (M4): which vocabulary of combos and ladders. */}
        <PickerRow
          id="tier"
          testID="tier"
          label="Tier"
          caption="Which combination families and build-up ladders the coach draws from."
          value={tierFor(recipe)}
          options={TIER_OPTIONS}
          onChange={(tier) => setRecipe({ tier })}
        />

        {/* 3b — Focus */}
        <PickerRow
          id="focus"
          testID="focus"
          label="Focus"
          value={recipe.focus}
          options={FOCUS_OPTIONS}
          onChange={(focus) => setRecipe({ focus })}
        />

        {/* 4 — Stance (and switch mode as options in the same list) */}
        <PickerRow
          id="stance"
          testID="stance"
          label="Stance"
          caption={
            recipe.stanceMode === 'fixed'
              ? undefined
              : `Starts ${recipe.defaultStance}. Stance changes at round boundaries.`
          }
          value={stanceChoiceFor(recipe)}
          options={STANCE_OPTIONS}
          onChange={(choice) => setRecipe(patchForStanceChoice(choice))}
        />

        {/* 5 — Hand bias */}
        <PickerRow
          id="bias"
          testID="bias"
          label="Hand bias"
          value={recipe.bias}
          options={BIAS_OPTIONS}
          onChange={(bias) => setRecipe({ bias })}
        />

        {/* 6 — Voice coach (mode + vocabulary as two stacked picks) */}
        <PickerRow
          id="voice-mode"
          testID="voice-mode"
          label="Voice coach"
          value={recipe.voiceMode}
          options={VOICE_MODE_OPTIONS}
          onChange={(voiceMode) => setRecipe({ voiceMode })}
        />
        <PickerRow
          id="voice-vocabulary"
          testID="voice-vocabulary"
          label="Voice vocabulary"
          value={recipe.voiceVocabulary}
          options={VOICE_VOCABULARY_OPTIONS}
          onChange={(voiceVocabulary) => setRecipe({ voiceVocabulary })}
        />

        {/* 7 — Plan behavior */}
        <PickerRow
          id="plan"
          testID="plan"
          label="Plan behavior"
          value={recipe.adaptationMode}
          options={PLAN_OPTIONS}
          onChange={(adaptationMode) => setRecipe({ adaptationMode })}
        />

        {/* Advanced — the enablement menu wrapped in the same collapse
            pattern as every picker row, so it defaults closed and the
            recipe fits on one screen. The menu itself drives every toggle
            unchanged. */}
        <CollapsibleSection
          id="advanced"
          testID="advanced"
          label="Advanced"
          caption="Which punches, defense, footwork and coaching calls the workout may use."
        >
          <EnablementMenu recipe={recipe} conflicts={allConflicts} onChange={setRecipe} />
        </CollapsibleSection>

        {/* Sample — as a picker row so it stays one line by default. */}
        <PickerRow
          id="sample"
          testID="sample"
          label="Start with a sample"
          value={selectedSampleKey ?? 'none'}
          options={sampleOptions}
          onChange={(key) => selectSample(key === 'none' ? undefined : (key as SampleWorkoutKey))}
        />

        <RecipeSummaryCard summary={summary} conflicts={allConflicts} />

        <View style={styles.actions}>
          {/* The authored art IS the button — pill, icon, chevron and neon
              rim are baked into the PNG, so no ForgedButton chrome here. */}
          {startBlocked ? (
            // No Link at all while blocked: a disabled child inside one
            // would depend on the router honouring the child's `disabled`.
            <ActionButton action="startWorkout" testID="start-button" disabled />
          ) : (
            <Link href="/(tabs)/punchcraft/live" asChild>
              <ActionButton action="startWorkout" testID="start-button" />
            </Link>
          )}
          {startBlocked ? (
            <Text style={styles.startBlocked} testID="start-blocked" accessibilityRole="alert">
              {`Start is off until this is fixed: ${blockers.map((c) => c.message).join(' ')}`}
            </Text>
          ) : null}
          {/* What the live screen really does (`_useLivePunchSource`): the
              gloves when both are connected, the simulator otherwise — and
              outside a development or QA run nothing drives the simulator,
              so the workout runs with nothing to count. This used to say the
              trackers were not wired in yet; they have been since M33-01. */}
          <Text style={styles.startCaption} testID="start-caption">
            Counts your punches when both gloves are connected. Without them the workout still runs
            — it just has nothing to count.
          </Text>

          <ForgedButton variant="subtle" onPress={resetRecipe} testID="reset-button">
            Reset to defaults
          </ForgedButton>
        </View>
      </ScrollView>
    </PickerProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  container: { padding: 16, gap: 10, paddingBottom: 32 },
  intro: {
    fontSize: sizes.label,
    fontFamily: fonts.body,
    lineHeight: 18,
    color: colors.textSecondary,
    marginBottom: 4,
  },

  goalExtras: { gap: 12, alignItems: 'flex-start' },

  extremeWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: 8,
    backgroundColor: colors.surface,
    padding: 10,
  },
  warningIconBox: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.warning,
    alignItems: 'center',
    justifyContent: 'center',
  },
  warningIcon: {
    fontSize: sizes.label,
    fontFamily: fonts.heading,
    lineHeight: 14,
    color: colors.warning,
  },
  extremeWarningText: {
    flex: 1,
    fontSize: sizes.label,
    fontFamily: fonts.body,
    lineHeight: 18,
    color: colors.textPrimary,
  },

  actions: { gap: 8, marginTop: 4 },
  startBlocked: {
    fontSize: sizes.label,
    fontFamily: fonts.body,
    lineHeight: 18,
    color: colors.danger,
    textAlign: 'center',
  },
  startCaption: {
    fontSize: sizes.label,
    fontFamily: fonts.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
})
