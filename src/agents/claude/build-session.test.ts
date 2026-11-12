import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadSessions } from '../../discover.ts'
import { emptyCounters } from '../../parse/common.ts'
import type { Session } from '../../types.ts'
import { parseSessionFile } from './build-session.ts'
import { claudeSource } from './index.ts'

const ROOT = join(import.meta.dir, '..', '..', '__fixtures__', 'projects')
const at = (root: string) => [{ source: claudeSource, root }]
const DEMO = join(
  ROOT,
  '-tmp-demo-app',
  '11111111-1111-4111-8111-111111111111.jsonl',
)
const LEGACY = join(
  ROOT,
  '-tmp-legacy',
  '44444444-4444-4444-8444-444444444444.jsonl',
)

async function parseOk(path: string) {
  const counters = emptyCounters()
  const outcome = await parseSessionFile(path, counters)
  if (outcome.status !== 'ok')
    throw new Error(`expected ok, got ${outcome.status}`)
  return { s: outcome.session, counters }
}

describe('parseSessionFile (current transcript shape)', () => {
  test('takes project, branch and entrypoint from the first line with a cwd', async () => {
    const { s } = await parseOk(DEMO)
    expect(s.id).toBe('11111111-1111-4111-8111-111111111111')
    expect(s.project).toBe('/tmp/demo-app')
    expect(s.projectLabel).toBe('demo-app')
    expect(s.branch).toBe('main')
    expect(s.entrypoint).toBe('cli')
  })

  test('keeps only prompts a person typed, plus slash commands with intent', async () => {
    const { s } = await parseOk(DEMO)
    expect(s.prompts.map((p) => [p.text, p.source])).toEqual([
      ['Fix the failing login test in auth.spec.ts', 'typed'],
      ['/review 42', 'command'],
      ['ok', 'typed'],
      ['Also update the docs for the login flow please', 'queued'],
    ])
    expect(s.slashCommands).toEqual(['model', 'review'])
  })

  test('orders tool steps with coarse details and marks errors', async () => {
    const { s } = await parseOk(DEMO)
    expect(
      s.steps.map((st) => `${st.tool}:${st.detail}:${st.isError ? 'E' : ''}`),
    ).toEqual([
      'Read:ts:',
      'Edit:ts:',
      'Bash:package_manager:E',
      'Edit:ts:',
      'Bash:package_manager:E',
      'Edit:ts:',
      'Bash:package_manager:E',
      'mcp:github:E',
      'Agent:Explore:',
    ])
    expect(s.errors).toBe(4)
    expect(s.denials).toBe(1)
    expect(s.bashRuns.map((r) => r.normalized)).toEqual([
      'bun test auth',
      'bun test auth',
      'bun test auth',
    ])
  })

  test('counts usage once per message id, not once per split line', async () => {
    const { s } = await parseOk(DEMO)
    // msg_1 is written as two lines; both repeat the same usage.
    expect(s.messageUsage.msg_1?.totals).toEqual({
      input: 10,
      output: 20,
      cacheWrite5m: 0,
      cacheWrite1h: 100,
      cacheRead: 1000,
    })
    const opus = s.tokens['claude-opus-5-5']!
    // msg_1 + three edits + three bash runs + msg_8
    expect(opus.input).toBe(10 + 3 * 5 + 3 * 5 + 7)
    expect(opus.output).toBe(20 + 3 * 50 + 3 * 30 + 70)
    expect(opus.cacheWrite5m).toBe(300)
    // Subagent models are merged later, by loadSessions.
    expect(s.models).toEqual(['claude-opus-5-5'])
  })

  test('skips <synthetic> messages for usage and models', async () => {
    const { s } = await parseOk(DEMO)
    expect(s.messageUsage.msg_synth).toBeUndefined()
    expect(s.models).not.toContain('<synthetic>')
  })

  test('records compactions, interrupts, and an interrupted ending', async () => {
    const { s } = await parseOk(DEMO)
    expect(s.compactions).toBe(1)
    expect(s.interrupts).toBe(1)
    expect(s.endedAfterInterrupt).toBe(true)
    expect(s.interruptedTurnMessageIds).toEqual(['msg_8'])
  })

  test('counts malformed lines and sorts ignored from unknown line types', async () => {
    const { counters } = await parseOk(DEMO)
    // `{not valid json` and `[1,2,3]`; the blank line is not counted.
    expect(counters.malformedLines).toBe(2)
    expect(counters.ignoredLineTypes).toMatchObject({
      'last-prompt': 1,
      'ai-title': 1,
      mode: 1,
      'api-request': 1,
      attachment: 1,
    })
    expect(counters.unknownLineTypes).toEqual({ 'brand-new-thing': 1 })
  })
})

describe('parseSessionFile (older transcript shape)', () => {
  test('falls back to excluding wrappers when there is no origin field', async () => {
    const { s } = await parseOk(LEGACY)
    expect(s.prompts.map((p) => [p.text, p.source])).toEqual([
      ['Write a migration that adds an index on orders.created_at', 'legacy'],
      ['Now run it against the staging database', 'legacy'],
    ])
    // `/clear` with no args is not intent.
    expect(s.slashCommands).toEqual(['clear'])
  })

  test('uses the file name as the session id when a file holds two sessionIds', async () => {
    const { s } = await parseOk(LEGACY)
    expect(s.id).toBe('44444444-4444-4444-8444-444444444444')
  })

  test('prices a cache-creation total without a breakdown as 5-minute writes', async () => {
    const { s } = await parseOk(LEGACY)
    expect(s.messageUsage.lm1?.totals.cacheWrite5m).toBe(1000)
    expect(s.messageUsage.lm1?.totals.cacheWrite1h).toBe(0)
  })

  test('an interrupt followed by a typed prompt is not an interrupted ending', async () => {
    const { s } = await parseOk(LEGACY)
    expect(s.interrupts).toBe(1)
    expect(s.endedAfterInterrupt).toBe(false)
  })
})

describe('loadSessions', () => {
  test('skips frisk-made and prompt-less sessions, and rolls up subagent usage', async () => {
    const { sessions, stats } = await loadSessions(at(ROOT), { sinceMs: 0 })
    expect(stats.files).toBe(4)
    expect(stats.skippedFriskSelf).toBe(1)
    expect(stats.skippedNoPrompt).toBe(1)
    expect(stats.subagentFiles).toBe(1)
    expect(sessions.map((s) => s.id).sort()).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '44444444-4444-4444-8444-444444444444',
    ])
    const demo = sessions.find((s) => s.id.startsWith('1111')) as Session
    expect(demo.subagents.count).toBe(1)
    // Split over two lines, counted once.
    expect(demo.subagents.tokens['claude-haiku-5-5']?.input).toBe(100)
    expect(demo.tokens['claude-haiku-5-5']?.input).toBe(100)
    expect(demo.models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
  })

  test('filters by project substring and caps by most recent', async () => {
    const byProject = await loadSessions(at(ROOT), {
      sinceMs: 0,
      project: 'legacy',
    })
    expect(byProject.sessions.map((s) => s.projectLabel)).toEqual(['legacy'])
    expect(byProject.filteredByProject).toBe(1)
    const capped = await loadSessions(at(ROOT), { sinceMs: 0, maxSessions: 1 })
    expect(capped.sessions.map((s) => s.projectLabel)).toEqual(['legacy'])
  })

  test('drops sessions that ended before the window', async () => {
    const { sessions, stats } = await loadSessions(at(ROOT), {
      sinceMs: Date.parse('2026-11-04T00:00:00Z'),
    })
    expect(sessions.map((s) => s.projectLabel)).toEqual(['legacy'])
    expect(stats.skippedOutsideWindow).toBeGreaterThanOrEqual(1)
  })

  test('reports progress once per file, starting at zero', async () => {
    const calls: [string, number, number][] = []
    await loadSessions(at(ROOT), {
      sinceMs: 0,
      onProgress: (agent, done, total) => calls.push([agent, done, total]),
    })
    expect(calls.map(([, done]) => done)).toEqual([0, 1, 2, 3, 4])
    expect(
      calls.every(([agent, , total]) => agent === 'Claude Code' && total === 4),
    ).toBe(true)
  })

  test('returns nothing for a missing root', async () => {
    const { sessions, stats } = await loadSessions(
      at(join(ROOT, 'does-not-exist')),
      { sinceMs: 0 },
    )
    expect(sessions).toEqual([])
    expect(stats.files).toBe(0)
  })
})
