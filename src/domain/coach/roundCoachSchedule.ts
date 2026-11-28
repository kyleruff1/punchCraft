/**
 * A round's coach schedule: which bars are called, with which clip, at what
 * moment on the round's work clock — and which section lead-ins go between
 * them.
 *
 * ## Why this is its own module
 *
 * `callPlacement.ts` holds WHEN one call or one lead-in is placed. This holds
 * the rule above it — WHICH bars get a call, which section gets a lead-in,
 * which calls give way to one, and the order they go out in. That rule lived
 * inside `_useWorkoutRunner.ts`, a React hook, and the verifier's manifest
 * generator kept a second copy of it. The copy drifted, twice:
 *
 * - it anchored a lead-in to the section's first strike where the runner
 *   anchors it to the rep-0 call (fixed in `callPlacement.ts`);
 * - it worked out each call's window with arithmetic of its own — the bar's
 *   start, less the clip, less a 100 ms pad that the app replaced with 500
 *   in September — where the runner places a call with `callDispatchAtMs`
 *   (a set-aware breath and the dispatch lag, ahead of the bar's first
 *   punch). Its windows sat later than the runner's, so it pruned calls
 *   against a lead-in that the runner keeps, and expected one to three fewer
 *   calls than the runner sends: in 20 of 44 whole-workout runs the runner
 *   dispatched MORE calls than the manifest expected, and a round could lose
 *   that many and still pass (findings doc, N-20).
 *
 * So there is one rule, here, and both call it. What the manifest then
 * proves is that the device carried this schedule out; that the rule itself
 * is right is this module's own tests.
 *
 * Clips are looked up through two functions the caller passes in. The bank
 * lives under `src/audio`, which the domain does not import (Rule 2), and
 * the generic `C` carries whatever a clip is to the caller — the runner's
 * has a `module` to play, a tool's may not.
 */
import type { CueInstance } from '../programs/CueTimeline'
import { callDispatchAtMs, leadInDispatchAtMs, type CallVocabulary } from './callPlacement'
import { motifOf } from './callSlot'

/** What the rule needs of a clip: its words, and how long it runs. */
export interface CoachClip {
  text: string
  durationMs: number
}

export interface PlannedLeadIn<C extends CoachClip> {
  kind: 'lead-in'
  slot: string
  clip: C
  /** Fire when the round's work clock reaches this. */
  dispatchAtMs: number
  /** Past this the clip is no longer useful: the moment it was to END by. */
  giveUpAtMs: number
}

export interface PlannedCall<C extends CoachClip> {
  kind: 'call'
  slot: string
  clip: C
  dispatchAtMs: number
  /** A call that could not start by the bar's first beats is noise. */
  giveUpAtMs: number
  /** The bar's first punch, which the call must end a breath before. */
  firstNodeMs: number
  /** The breath that was intended between the call's end and that punch. */
  breathMs: number
  /** The bar this call covers. */
  cueId: string
  /**
   * A section's rep-0 call, sequenced right after its lead-in. It is exempt
   * from giving way to that lead-in, and from the runner's busy-lane retry.
   */
  firstRep: boolean
}

export type PlannedCoachEntry<C extends CoachClip> = PlannedLeadIn<C> | PlannedCall<C>

export interface RoundCoachSchedule<C extends CoachClip> {
  /** Lead-ins and the calls that survive them, in the order they go out. */
  entries: PlannedCoachEntry<C>[]
  /** The bars that keep a call — "lit means spoken" reads this. */
  calledCueIds: Set<string>
}

/** A call's window must clear a lead-in's by this much before the lead-in starts. */
export const LEAD_IN_GUARD_MS = 500
/** How long after a bar's first punch its call is still worth starting. */
export const CALL_GIVE_UP_AFTER_FIRST_NODE_MS = 500

export function planRoundCoachSchedule<C extends CoachClip>(args: {
  workoutId: string
  roundIndex: number
  cues: readonly CueInstance[]
  vocabulary: CallVocabulary
  /** The call clip for a bar's motif, and the slot it was found under. */
  findCall: (motif: string) => { slot: string; clip: C } | undefined
  /** The clip authored for a lead-in slot, if there is one. */
  findLeadIn: (slot: string) => C | undefined
}): RoundCoachSchedule<C> {
  const { workoutId, roundIndex, cues, vocabulary, findCall, findLeadIn } = args
  const seenBlocks = new Set<string>()
  const leadIns: PlannedLeadIn<C>[] = []
  const calls: PlannedCall<C>[] = []

  // The call for one bar: its motif named so it FINISHES a set-aware breath
  // before the bar's first shot, anchored to the first PUNCH (a bar may open
  // on a rest).
  const planCall = (cue: CueInstance, firstRep: boolean): PlannedCall<C> | null => {
    const found = findCall(motifOf(cue.tokens))
    if (!found) return null
    const { slot, clip } = found
    const { dispatchAtMs, firstNodeMs, breathMs } = callDispatchAtMs({
      cue,
      scheduledStartMs: cue.scheduledStartMs,
      vocabulary,
      slot,
      clipDurationMs: clip.durationMs,
    })
    return {
      kind: 'call',
      slot,
      clip,
      breathMs,
      dispatchAtMs,
      giveUpAtMs: firstNodeMs + CALL_GIVE_UP_AFTER_FIRST_NODE_MS,
      firstNodeMs,
      cueId: cue.id,
      firstRep,
    }
  }

  for (const cue of cues) {
    // Before anything is counted: a bar that is not a sequence is no section.
    if (cue.scoring !== 'sequence') continue
    if (cue.repeatIndex === 0 && !seenBlocks.has(cue.blockId)) {
      seenBlocks.add(cue.blockId)
      // Every section's rep 0 gets its call — the round opener included.
      // (Kyle, 2026-09-04: the first set of every section was MUTED — the
      // lead-in described it, rep 0 was thrown in silence, the coach came in
      // on rep 1. Each round's first row carries an authored setup pad, so
      // the bell releases into a breath, the rep-0 call, then the punches.
      // The opener is still NAMED before the bell — round 1 in the walkout,
      // later rounds in the countdown — and that ceremony is unchanged.)
      const rep0Call = planCall(cue, true)
      if (rep0Call) calls.push(rep0Call)
      // A section is the block's ORDER in the round, not its id. Section 1
      // has no mid-round lead-in (the pre-bell ceremony names it); sections
      // 2 and on sequence lead-in → rep-0 call inside their pads.
      if (seenBlocks.size > 1) {
        const slot = `lead-in/${workoutId}/r${roundIndex + 1}s${seenBlocks.size}`
        const clip = findLeadIn(slot)
        if (clip) {
          // End before the rep-0 call starts — or, with no rep-0 call,
          // before the section's first shot.
          const { dispatchAtMs, endByMs } = leadInDispatchAtMs({
            ...(rep0Call ? { rep0CallDispatchAtMs: rep0Call.dispatchAtMs } : {}),
            scheduledStartMs: cue.scheduledStartMs,
            clipDurationMs: clip.durationMs,
            vocabulary,
          })
          leadIns.push({ kind: 'lead-in', slot, clip, dispatchAtMs, giveUpAtMs: endByMs })
        }
      }
      continue
    }
    const call = planCall(cue, false)
    if (call) calls.push(call)
  }

  // A call whose window overlaps a lead-in's guarded window is dropped here,
  // when the round is planned, so the coach lane is free when the lead-in
  // comes due: a lead-in must never starve behind calls.
  const survivors = calls.filter((call) => {
    // The rep-0 call is sequenced right after its section's lead-in on
    // purpose — it is not a collision with it.
    if (call.firstRep) return true
    const callEnd = call.dispatchAtMs + call.clip.durationMs
    return !leadIns.some((leadIn) => {
      const guardedFrom = leadIn.dispatchAtMs - LEAD_IN_GUARD_MS
      const leadInEnd = leadIn.dispatchAtMs + leadIn.clip.durationMs
      return call.dispatchAtMs < leadInEnd && callEnd > guardedFrom
    })
  })

  // Lead-ins first, so that at a tie the lead-in goes out before the call
  // (the sort is stable): the first one sent makes the lane busy for the next.
  const entries: PlannedCoachEntry<C>[] = [...leadIns, ...survivors].sort(
    (a, b) => a.dispatchAtMs - b.dispatchAtMs,
  )
  return { entries, calledCueIds: new Set(survivors.map((call) => call.cueId)) }
}
