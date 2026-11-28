/**
 * The rule that turns a round's bars into its calls and lead-ins.
 *
 * The verifier's manifest is this function's output, so the verifier can no
 * longer catch the rule being wrong — only the device not carrying it out.
 * These are the tests that hold the rule itself. The WHEN of a single call
 * is `callPlacement`'s and is tested there; what is held here is WHICH bars
 * are called, which sections get a lead-in, which calls give way, and the
 * order.
 *
 * The round: three sections of a repeated combination at 120 BPM, with a
 * count-scored block between the first two — which is no section at all.
 */
import { expandTimeline, type CueInstance } from '../../programs/CueTimeline'
import { bpmForRecipe } from '../../workout/cadence'
import type { GeneratedWorkout } from '../../workout/GeneratedWorkout'
import { defaultRecipe } from '../../workout/WorkoutRecipe'
import type { WorkoutBlock } from '../../workout/WorkoutTokens'
import {
  CALL_GIVE_UP_AFTER_FIRST_NODE_MS,
  LEAD_IN_GUARD_MS,
  planRoundCoachSchedule,
  type CoachClip,
  type PlannedCall,
  type PlannedLeadIn,
} from '../roundCoachSchedule'

const punch = (number: 1 | 2 | 3, beatOffset: number) => ({
  kind: 'punch' as const,
  number,
  body: false,
  beatOffset,
})

const combo = (id: string, startOffsetMs: number, numbers: Array<1 | 2 | 3>): WorkoutBlock => ({
  id,
  kind: 'repeated-combo',
  stance: 'inherit',
  startOffsetMs,
  durationMs: 12_000,
  gapBeats: 2,
  repeat: 3,
  tokens: numbers.map((n, i) => punch(n, i)),
})

const WORKOUT: GeneratedWorkout = {
  id: 'planner-fixture',
  recipe: defaultRecipe(),
  schedule: [
    {
      id: 'r1',
      order: 1,
      kind: 'round',
      countsTowardGoal: true,
      theme: 'Round 1',
      workDurationMs: 60_000,
      restAfterMs: 0,
      targetPunches: 30,
      blocks: [combo('b1', 0, [1, 2]), combo('b2', 20_000, [1, 1, 2]), combo('b3', 40_000, [3, 2])],
    },
  ],
  roundPunchTargets: [30],
  expectedTechniqueDistribution: {},
  estimatedActivePunchesPerMinute: 60,
  warnings: [],
}

const CUES: CueInstance[] = expandTimeline(WORKOUT, 'orthodox', bpmForRecipe(WORKOUT.recipe))[0]!
  .cues

/** A clip bank: every motif has a one-second call unless named in `without`. */
const calls =
  (without: string[] = [], durationMs = 1_000) =>
  (motif: string): { slot: string; clip: CoachClip } | undefined =>
    without.includes(motif)
      ? undefined
      : { slot: `call/${motif}`, clip: { text: `call ${motif}`, durationMs } }

const leadIns =
  (bank: Record<string, number>) =>
  (slot: string): CoachClip | undefined =>
    slot in bank ? { text: `lead-in ${slot}`, durationMs: bank[slot]! } : undefined

const plan = (
  over: Partial<Parameters<typeof planRoundCoachSchedule<CoachClip>>[0]> = {},
): ReturnType<typeof planRoundCoachSchedule<CoachClip>> =>
  planRoundCoachSchedule<CoachClip>({
    workoutId: WORKOUT.id,
    roundIndex: 0,
    cues: CUES,
    vocabulary: 'numbers',
    findCall: calls(),
    findLeadIn: leadIns({}),
    ...over,
  })

const isCall = (e: { kind: string }): e is PlannedCall<CoachClip> => e.kind === 'call'
const isLeadIn = (e: { kind: string }): e is PlannedLeadIn<CoachClip> => e.kind === 'lead-in'

describe('the fixture', () => {
  it('is three sections of three reps', () => {
    expect(CUES.map((c) => `${c.blockId}#${c.repeatIndex}`)).toEqual([
      'b1#0',
      'b1#1',
      'b1#2',
      'b2#0',
      'b2#1',
      'b2#2',
      'b3#0',
      'b3#1',
      'b3#2',
    ])
    expect(CUES.every((c) => c.scoring === 'sequence')).toBe(true)
  })
})

describe('which bars are called', () => {
  it('calls every bar whose motif has a clip, under the slot the bank found it', () => {
    const { entries, calledCueIds } = plan()
    expect(entries.every(isCall)).toBe(true)
    expect(entries.map((e) => e.slot)).toEqual([
      'call/1-2',
      'call/1-2',
      'call/1-2',
      'call/1-1-2',
      'call/1-1-2',
      'call/1-1-2',
      'call/3-2',
      'call/3-2',
      'call/3-2',
    ])
    expect([...calledCueIds]).toEqual(CUES.map((c) => c.id))
  })

  it('calls nothing for a motif the bank has no clip for, and does not count it as called', () => {
    const { entries, calledCueIds } = plan({ findCall: calls(['1-1-2']) })
    expect(entries.map((e) => e.slot)).toEqual([
      'call/1-2',
      'call/1-2',
      'call/1-2',
      'call/3-2',
      'call/3-2',
      'call/3-2',
    ])
    expect([...calledCueIds].some((id) => id.startsWith('b2'))).toBe(false)
  })

  it('marks the first rep of each section, and only that one', () => {
    const firstReps = plan()
      .entries.filter(isCall)
      .filter((e) => e.firstRep)
      .map((e) => e.cueId)
    expect(firstReps).toEqual([CUES[0]!.id, CUES[3]!.id, CUES[6]!.id])
  })

  it('gives every call up half a second after its bar’s first punch', () => {
    for (const call of plan().entries.filter(isCall)) {
      expect(call.giveUpAtMs).toBe(call.firstNodeMs + CALL_GIVE_UP_AFTER_FIRST_NODE_MS)
      // And it is sent to end a breath ahead of that punch — unless the round
      // has only just begun and there is no earlier moment to send it at.
      if (call.dispatchAtMs > 0) {
        expect(call.dispatchAtMs + call.clip.durationMs + call.breathMs).toBeLessThanOrEqual(
          call.firstNodeMs + 1,
        )
      }
    }
  })

  it('skips a bar that is not a sequence, before counting sections', () => {
    // A count-scored block between sections 1 and 2 is no section: section 2
    // must still be `s2`, or it would be called with section 3's lead-in.
    const counted: CueInstance = { ...CUES[2]!, id: 'count#0', blockId: 'count', repeatIndex: 0 }
    const cues = [
      ...CUES.slice(0, 3),
      { ...counted, scoring: 'count' as CueInstance['scoring'] },
      ...CUES.slice(3),
    ]
    const bank = leadIns({
      'lead-in/planner-fixture/r1s2': 800,
      'lead-in/planner-fixture/r1s3': 800,
    })
    const { entries } = plan({ cues, findLeadIn: bank })
    expect(entries.some((e) => isCall(e) && e.cueId === 'count#0')).toBe(false)
    expect(entries.filter(isLeadIn).map((e) => e.slot)).toEqual([
      'lead-in/planner-fixture/r1s2',
      'lead-in/planner-fixture/r1s3',
    ])
  })
})

describe('section lead-ins', () => {
  const bank = leadIns({
    'lead-in/planner-fixture/r1s1': 800,
    'lead-in/planner-fixture/r1s2': 800,
    'lead-in/planner-fixture/r1s3': 800,
    'lead-in/planner-fixture/r2s2': 800,
  })

  it('go to sections 2 and on — never section 1, which the bell’s ceremony names', () => {
    const slots = plan({ findLeadIn: bank })
      .entries.filter(isLeadIn)
      .map((e) => e.slot)
    expect(slots).toEqual(['lead-in/planner-fixture/r1s2', 'lead-in/planner-fixture/r1s3'])
  })

  it('are named for the round they are in', () => {
    const slots = plan({ roundIndex: 1, findLeadIn: bank })
      .entries.filter(isLeadIn)
      .map((e) => e.slot)
    // Round 2 has a clip for its section 2 only.
    expect(slots).toEqual(['lead-in/planner-fixture/r2s2'])
  })

  it('end before their section’s rep-0 call starts', () => {
    const { entries } = plan({ findLeadIn: bank })
    for (const leadIn of entries.filter(isLeadIn)) {
      const section = Number(leadIn.slot.at(-1))
      const rep0 = entries.filter(isCall).filter((e) => e.firstRep)[section - 1]!
      expect(leadIn.dispatchAtMs + leadIn.clip.durationMs).toBeLessThanOrEqual(rep0.dispatchAtMs)
      expect(leadIn.giveUpAtMs).toBeGreaterThanOrEqual(leadIn.dispatchAtMs + leadIn.clip.durationMs)
    }
  })

  it('go out in time order with the calls around them', () => {
    const { entries } = plan({ findLeadIn: bank })
    const times = entries.map((e) => e.dispatchAtMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(entries.map((e) => (isLeadIn(e) ? 'L' : e.firstRep ? 'C0' : 'c')).join(' ')).toBe(
      'C0 c c L C0 c c L C0 c c',
    )
  })
})

describe('a call that would run into a lead-in gives way', () => {
  // Section 1's three bars start at 0, 2 and 4 s; section 2 opens at 20 s. A
  // sixteen-second lead-in for section 2 reaches back over section 1's tail.
  const long = leadIns({ 'lead-in/planner-fixture/r1s2': 16_000 })

  it('is dropped when the round is planned, and is no longer "called"', () => {
    const quiet = plan()
    const withLeadIn = plan({ findLeadIn: long })
    const leadIn = withLeadIn.entries.find(isLeadIn)!
    const dropped = quiet.entries
      .filter(isCall)
      .filter((call) => !withLeadIn.entries.some((e) => isCall(e) && e.cueId === call.cueId))
    // Something was dropped, and it was section 1's tail — never a rep 0.
    expect(dropped.length).toBeGreaterThan(0)
    expect(dropped.every((call) => call.cueId.startsWith('b1') && !call.firstRep)).toBe(true)
    for (const call of dropped) {
      expect(withLeadIn.calledCueIds.has(call.cueId)).toBe(false)
      // Each one's window did reach into the lead-in's, guard included.
      expect(call.dispatchAtMs).toBeLessThan(leadIn.dispatchAtMs + leadIn.clip.durationMs)
      expect(call.dispatchAtMs + call.clip.durationMs).toBeGreaterThan(
        leadIn.dispatchAtMs - LEAD_IN_GUARD_MS,
      )
    }
  })

  it('keeps every call whose window is clear of it', () => {
    const withLeadIn = plan({ findLeadIn: long })
    const leadIn = withLeadIn.entries.find(isLeadIn)!
    for (const call of withLeadIn.entries.filter(isCall).filter((e) => !e.firstRep)) {
      const clear =
        call.dispatchAtMs >= leadIn.dispatchAtMs + leadIn.clip.durationMs ||
        call.dispatchAtMs + call.clip.durationMs <= leadIn.dispatchAtMs - LEAD_IN_GUARD_MS
      expect(clear).toBe(true)
    }
  })

  it('never drops a section’s rep-0 call for being next to its own lead-in', () => {
    const withLeadIn = plan({ findLeadIn: long })
    const rep0s = withLeadIn.entries.filter(isCall).filter((e) => e.firstRep)
    expect(rep0s.map((e) => e.cueId)).toEqual([CUES[0]!.id, CUES[3]!.id, CUES[6]!.id])
  })

  it('guards half a second ahead of the lead-in', () => {
    expect(LEAD_IN_GUARD_MS).toBe(500)
  })
})
