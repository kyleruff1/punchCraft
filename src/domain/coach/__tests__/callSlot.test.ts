/**
 * The call-clip key. Boxing is the absent segment, so adding a discipline
 * dimension moved nothing that already existed — which is the whole claim,
 * and what most of this pins.
 */
import { callSlot, motifOf } from '../callSlot'
import { BOXING, disciplineOf, isDisciplineSlug } from '@domain/workout/discipline'
import { listSampleWorkouts } from '@domain/workout/samples'

describe('motifOf', () => {
  it('spells a bar by its tokens: punch numbers, `b` for the body, `.` for anything else', () => {
    expect(
      motifOf([
        { kind: 'punch', number: 1, body: false },
        { kind: 'punch', number: 2, body: true },
        { kind: 'rest' },
        { kind: 'punch', number: 6 },
      ]),
    ).toBe('1-2b-.-6')
  })

  it('spells every bar of every library workout as the hand-written expression did', () => {
    // The expression that lived in the runner and in the verifier's manifest
    // generator before they shared this function.
    const legacy = (tokens: readonly { kind: string; number?: number; body?: boolean }[]) =>
      tokens.map((t) => (t.kind === 'punch' ? `${t.number}${t.body ? 'b' : ''}` : '.')).join('-')

    let bars = 0
    for (const { workout } of listSampleWorkouts()) {
      for (const round of workout.schedule) {
        for (const block of round.blocks) {
          bars += 1
          expect(motifOf(block.tokens)).toBe(legacy(block.tokens))
        }
      }
    }
    expect(bars).toBeGreaterThan(100)
  })
})

describe('callSlot', () => {
  it('spells a boxing slot exactly as it has always been spelled', () => {
    expect(callSlot('1-2-3-2')).toBe('call/1-2-3-2')
    expect(callSlot('1-2-3-2', BOXING)).toBe('call/1-2-3-2')
    expect(callSlot('1b-.-2-.', 'boxing')).toBe('call/1b-.-2-.')
  })

  it('gives another discipline its own segment', () => {
    expect(callSlot('1-2-3-2', 'reaction')).toBe('call/reaction/1-2-3-2')
    expect(callSlot('1-2-3-2', 'reaction')).not.toBe(callSlot('1-2-3-2'))
  })
})

describe('discipline', () => {
  it('reads a workout that says nothing as boxing', () => {
    expect(disciplineOf({})).toBe(BOXING)
    expect(disciplineOf({ discipline: 'reaction' })).toBe('reaction')
  })

  it('says none of the library workouts carries one — they are all boxing', () => {
    for (const { workout } of listSampleWorkouts()) {
      expect(workout.discipline).toBeUndefined()
    }
  })

  it('accepts only a lowercase slug, since it becomes a path segment', () => {
    for (const ok of ['boxing', 'reaction', 'target-tap', 'k1']) {
      expect(isDisciplineSlug(ok)).toBe(true)
    }
    for (const bad of ['', 'Boxing', 'target tap', '../x', 'call/x', '1st', 7, null, undefined]) {
      expect(isDisciplineSlug(bad)).toBe(false)
    }
  })
})
