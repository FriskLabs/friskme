import { describe, expect, it } from 'bun:test'
import {
  compressSteps,
  MAX_MOTIF_LENGTH,
  MIN_GROUP_STEPS,
} from './sequence-fold.ts'

const seq = (ids: string) => ids.split('')
const key = (id: string) => id

describe('compressSteps', () => {
  it('returns individual steps when nothing repeats', () => {
    const items = compressSteps(seq('ABC'), key)
    expect(items.map((i) => i.kind)).toEqual(['step', 'step', 'step'])
    expect(items).toHaveLength(3)
  })

  it('folds a run of one tool, preferring the shortest pattern', () => {
    const items = compressSteps(seq('AAAA'), key)
    expect(items).toHaveLength(1)
    const group = items[0]!
    if (group.kind !== 'group') throw new Error('expected group')
    expect(group.pattern).toEqual(['A'])
    expect(group.repeatCount).toBe(4)
    expect(group.startIndex).toBe(0)
    expect(group.endIndex).toBe(3)
  })

  it('folds a repeating two-tool motif', () => {
    const items = compressSteps(seq('ABABAB'), key)
    expect(items).toHaveLength(1)
    const group = items[0]!
    if (group.kind !== 'group') throw new Error('expected group')
    expect(group.pattern).toEqual(['A', 'B'])
    expect(group.repeatCount).toBe(3)
    expect(group.steps).toHaveLength(6)
  })

  it('leaves a two-step repeat uncompressed (below the 3-step floor)', () => {
    const items = compressSteps(seq('AAB'), key)
    expect(items.map((i) => i.kind)).toEqual(['step', 'step', 'step'])
  })

  it('folds a three-step run (at the floor)', () => {
    const items = compressSteps(seq('AAA'), key)
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('group')
  })

  it('prefers the motif that folds the most steps, not the first that matches', () => {
    // The motif's own body repeats, so a length-1 scan would match the
    // leading "AAA" and fragment the sequence into four items.
    const items = compressSteps(seq('AAABAAAB'), key)
    expect(items).toHaveLength(1)
    const group = items[0]!
    if (group.kind !== 'group') throw new Error('expected group')
    expect(group.pattern).toEqual(['A', 'A', 'A', 'B'])
    expect(group.repeatCount).toBe(2)
  })

  it('never folds a pattern longer than MAX_MOTIF_LENGTH', () => {
    const pattern = ['A', 'B', 'C', 'D', 'E']
    const items = compressSteps([...pattern, ...pattern], key)
    expect(items.every((i) => i.kind === 'step')).toBe(true)
    expect(MAX_MOTIF_LENGTH).toBe(4)
  })

  it('respects MIN_GROUP_STEPS as the minimum coverage to fold', () => {
    expect(MIN_GROUP_STEPS).toBe(3)
  })

  it('supports a custom key selector', () => {
    const steps = [
      { tool: 'search', ms: 10 },
      { tool: 'read', ms: 5 },
      { tool: 'search', ms: 12 },
      { tool: 'read', ms: 6 },
      { tool: 'search', ms: 9 },
      { tool: 'read', ms: 7 },
    ]
    const items = compressSteps(steps, (s) => s.tool)
    expect(items).toHaveLength(1)
    const group = items[0]!
    if (group.kind !== 'group') throw new Error('expected group')
    expect(group.pattern.map((s) => s.tool)).toEqual(['search', 'read'])
    expect(group.repeatCount).toBe(3)
  })
})
