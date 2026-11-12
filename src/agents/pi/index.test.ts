import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverPiFiles, piSessionsRoot } from './index.ts'
import { piToolDetail, piToolDisplayName, piToolKind } from './tools.ts'

const ROOT = join(import.meta.dir, '..', '..', '__fixtures__', 'pi', 'sessions')

describe('piSessionsRoot', () => {
  test('honors pi env overrides, session dir first', () => {
    expect(piSessionsRoot({})).toBe(join(homedir(), '.pi', 'agent', 'sessions'))
    expect(piSessionsRoot({ PI_CODING_AGENT_DIR: '/a' })).toBe('/a/sessions')
    expect(
      piSessionsRoot({
        PI_CODING_AGENT_DIR: '/a',
        PI_CODING_AGENT_SESSION_DIR: '/s',
      }),
    ).toBe('/s')
  })
})

describe('discoverPiFiles', () => {
  test('lists every session file with its id', async () => {
    const files = await discoverPiFiles(ROOT)
    expect(files.map((f) => f.sessionId)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ])
    expect(files.every((f) => f.subagentPaths.length === 0)).toBe(true)
  })

  test('a missing root yields nothing', async () => {
    expect(await discoverPiFiles('/does/not/exist')).toEqual([])
  })
})

describe('pi tools', () => {
  test('maps tool names onto kinds and coarse details', () => {
    const row = (name: string, args: unknown) => [
      piToolDisplayName(name),
      piToolKind(name),
      piToolDetail(name, args),
    ]
    expect(row('bash', { command: 'ls -la' })[1]).toBe('shell')
    expect(row('powershell', {})).toEqual(['powershell', 'shell', null])
    expect(row('edit', { path: 'a/b.tsx' })).toEqual(['edit', 'edit', 'tsx'])
    expect(row('write', { path: 'Makefile' })).toEqual([
      'write',
      'edit',
      'noext',
    ])
    expect(row('read', { path: 'x.md' })).toEqual(['read', 'read', 'md'])
    expect(row('grep', { pattern: 'x' })).toEqual(['grep', 'read', null])
    expect(row('find', {})).toEqual(['find', 'read', null])
    expect(row('ls', {})).toEqual(['ls', 'read', null])
    expect(row('subagent', { agent: 'scout' })).toEqual([
      'subagent',
      'subagent',
      'scout',
    ])
    expect(row('subagent', {})).toEqual(['subagent', 'subagent', 'general'])
    expect(row('mcp__linear__list_issues', {})).toEqual([
      'mcp',
      'mcp',
      'linear',
    ])
    expect(row('web_fetch', { url: 'x' })).toEqual(['web_fetch', 'other', null])
  })
})
