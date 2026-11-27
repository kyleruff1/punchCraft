/**
 * Which recorded clip speaks a bar's call, per discipline.
 */
import { findCallClip } from '@audio/voiceAssets/callClips'
import {
  CLICK_SCRIPT_CLIPS,
  findClickScript,
  type ClickScriptClip,
} from '@audio/voiceAssets/clickScriptManifest'
import { motifOf } from '@domain/coach/callSlot'
import { listSampleWorkouts } from '@domain/workout/samples'

const clip = (
  id: string,
  vocabulary: ClickScriptClip['vocabulary'],
  slot: string,
): ClickScriptClip => ({
  id,
  kind: 'call',
  vocabulary,
  text: id,
  slots: [slot],
  module: 0,
  durationMs: 900,
})

describe('boxing', () => {
  it('resolves every bar of every library workout to the clip it always had', () => {
    let resolved = 0
    for (const vocabulary of ['numbers', 'techniques'] as const) {
      for (const { workout } of listSampleWorkouts()) {
        for (const round of workout.schedule) {
          for (const block of round.blocks) {
            const motif = motifOf(block.tokens)
            const before = findClickScript(`call/${motif}`, vocabulary)
            const after = findCallClip(motif, vocabulary)
            expect(after?.clip).toBe(before)
            if (after) {
              expect(after.slot).toBe(`call/${motif}`)
              resolved += 1
            }
          }
        }
      }
    }
    // Not vacuous: the library really does have called bars.
    expect(resolved).toBeGreaterThan(100)
    expect(CLICK_SCRIPT_CLIPS.some((c) => c.kind === 'call')).toBe(true)
  })

  it('falls back from techniques to the numbers copy of the same slot', () => {
    const clips = [clip('n', 'numbers', 'call/1-2')]
    expect(findCallClip('1-2', 'techniques', 'boxing', clips)?.clip.id).toBe('n')
  })

  it('finds nothing for a bar nobody recorded', () => {
    expect(findCallClip('6-6-6-6', 'numbers', 'boxing', [])).toBeUndefined()
  })
})

describe('another discipline', () => {
  const shared = [clip('box-n', 'numbers', 'call/1-2'), clip('box-t', 'techniques', 'call/1-2')]

  it('uses its own clip when it has one, under its own slot', () => {
    const clips = [...shared, clip('rx-n', 'numbers', 'call/reaction/1-2')]
    expect(findCallClip('1-2', 'numbers', 'reaction', clips)).toEqual({
      slot: 'call/reaction/1-2',
      clip: clips[2],
    })
  })

  it('borrows the shared NUMBERS clip when it has none — digits belong to no discipline', () => {
    expect(findCallClip('1-2', 'numbers', 'reaction', shared)).toEqual({
      slot: 'call/1-2',
      clip: shared[0],
    })
  })

  it('never speaks boxing’s technique names: techniques falls back to numbers, not to them', () => {
    const found = findCallClip('1-2', 'techniques', 'reaction', shared)
    expect(found?.clip.id).toBe('box-n')
    expect(found?.clip.vocabulary).toBe('numbers')
  })

  it('prefers its own numbers clip to the shared one when asked for techniques it lacks', () => {
    const clips = [...shared, clip('rx-n', 'numbers', 'call/reaction/1-2')]
    expect(findCallClip('1-2', 'techniques', 'reaction', clips)?.clip.id).toBe('rx-n')
  })

  it('uses its own technique words when it has them', () => {
    const clips = [...shared, clip('rx-t', 'techniques', 'call/reaction/1-2')]
    expect(findCallClip('1-2', 'techniques', 'reaction', clips)?.clip.id).toBe('rx-t')
  })
})
