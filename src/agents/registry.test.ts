import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSessions } from '../discover.ts'
import { parseAgentList, resolveSources } from './registry.ts'

const FIX = join(import.meta.dir, '..', '__fixtures__')
const env = { CLAUDE_CONFIG_DIR: FIX, CODEX_HOME: join(FIX, 'codex') }

describe('registry', () => {
  test('parses --agent lists', () => {
    expect(parseAgentList('claude')).toEqual(['claude'])
    expect(parseAgentList(' Codex , claude,codex')).toEqual(['codex', 'claude'])
    expect(() => parseAgentList('cursor')).toThrow('unknown agent "cursor"')
    expect(() => parseAgentList(',')).toThrow('at least one agent')
  })

  test('scans every agent whose folder exists, unless told which', () => {
    expect(resolveSources(env).map((s) => [s.source.id, s.root])).toEqual([
      ['claude', join(FIX, 'projects')],
      ['codex', join(FIX, 'codex', 'sessions')],
    ])
    expect(
      resolveSources({
        CLAUDE_CONFIG_DIR: FIX,
        CODEX_HOME: '/does/not/exist',
      }).map((s) => s.source.id),
    ).toEqual(['claude'])
    // Asked for explicitly, a missing folder is still scanned (and found empty).
    expect(
      resolveSources({ CODEX_HOME: '/does/not/exist' }, ['codex']).map(
        (s) => s.source.id,
      ),
    ).toEqual(['codex'])
  })

  test('one load merges agents, newest first, with per-agent stats', async () => {
    const { sessions, stats } = await loadSessions(resolveSources(env), {
      sinceMs: 0,
    })
    expect(stats.byAgent).toEqual({
      claude: { files: 4, sessions: 2 },
      codex: { files: 5, sessions: 3 },
    })
    expect(new Set(sessions.map((s) => s.agent))).toEqual(
      new Set(['claude', 'codex']),
    )
    const starts = sessions.map((s) => s.start)
    expect([...starts].sort().reverse()).toEqual(starts)
  })
})
