import { describe, expect, test } from 'bun:test'
import { runtimeProblem } from './runtime-check.ts'

const node = (v: string) => ({ node: v }) as NodeJS.ProcessVersions

describe('runtimeProblem', () => {
  test('accepts Node 22.15 and newer', () => {
    for (const v of ['22.15.0', '22.20.1', '23.0.0', '24.22.0'])
      expect(runtimeProblem(node(v))).toBeNull()
  })

  test('rejects older Node with the version it needs', () => {
    for (const v of ['22.14.0', '20.14.0', '18.17.0'])
      expect(runtimeProblem(node(v))).toContain('Node 22.15 or newer')
  })

  test('Bun passes', () => {
    expect(
      runtimeProblem({
        node: '20.0.0',
        bun: '1.4.3',
      } as NodeJS.ProcessVersions),
    ).toBeNull()
  })
})
