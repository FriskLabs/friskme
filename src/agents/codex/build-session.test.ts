import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSessions } from '../../discover.ts'
import { emptyCounters, type TextVisit } from '../../parse/common.ts'
import type { Session } from '../../types.ts'
import { parseCodexSession, typedText } from './build-session.ts'
import { codexSource, discoverCodexFiles } from './index.ts'

const ROOT = join(
  import.meta.dir,
  '..',
  '..',
  '__fixtures__',
  'codex',
  'sessions',
)
const DAY = join(ROOT, '2026', '11', '05')
const file = (id: string) => {
  const name = readdirSync(DAY).find((f) => f.includes(id))
  if (!name) throw new Error(`no fixture for ${id}`)
  return join(DAY, name)
}
const MAIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NEW = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const OLD = '99999999-9999-4999-8999-999999999999'

async function parseOk(path: string, onText?: (v: TextVisit) => void) {
  const counters = emptyCounters()
  const out = await parseCodexSession(path, counters, onText)
  if (out.status !== 'ok') throw new Error(`expected ok, got ${out.status}`)
  return { s: out.session, counters }
}

const tmp: string[] = []
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

describe('typedText', () => {
  test('drops injected blocks and keeps what a person typed', () => {
    expect(
      typedText('<environment_context>\n<cwd>/x</cwd>\n</environment_context>'),
    ).toBeNull()
    expect(
      typedText('# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>…'),
    ).toBeNull()
    expect(typedText('<turn_aborted>\nstop\n</turn_aborted>')).toBeNull()
    expect(
      typedText(
        '<system_instruction>a</system_instruction>\n<system_instruction>b</system_instruction>\nfix it',
      ),
    ).toBe('fix it')
    expect(
      typedText(
        '# Context from my IDE setup:\n\n## Active file: a.ts\n\n## My request for Codex:\nadd tests',
      ),
    ).toBe('add tests')
    expect(typedText('use <b>bold</b> here')).toBe('use <b>bold</b> here')
  })
})

describe('parseCodexSession', () => {
  test('folds prompts, tool steps, errors and session facts', async () => {
    const { s, counters } = await parseOk(file(MAIN))
    expect(s.id).toBe(MAIN)
    expect(s.agent).toBe('codex')
    expect(s.project).toBe('/tmp/codex-demo')
    expect(s.projectLabel).toBe('codex-demo')
    expect(s.branch).toBe('main')
    expect(s.entrypoint).toBe('cli')
    expect(s.prompts.map((p) => p.text)).toEqual([
      'Fix the failing add() test in src/math.ts',
      'Now add a test for negative numbers',
    ])
    expect(
      s.steps.map((st) => [st.tool, st.kind, st.detail, st.isError]),
    ).toEqual([
      ['exec_command', 'shell', 'package_manager', true],
      ['apply_patch', 'edit', 'ts', false],
      ['shell', 'shell', 'package_manager', false],
      ['spawn_agent', 'subagent', 'reviewer', false],
      ['mcp', 'mcp', 'linear', false],
    ])
    expect(s.errors).toBe(1)
    expect(s.bashRuns.map((r) => [r.normalized, r.isError])).toEqual([
      ['bun test src/math.test.ts', true],
      ['bun test src/math.test.ts', false],
    ])
    expect(s.compactions).toBe(1)
    expect(counters.ignoredLineTypes).toEqual({ world_state: 1 })
    expect(counters.unknownLineTypes).toEqual({ mystery_record: 1 })
  })

  test('normalizes OpenAI usage, skips repeated totals and links steps to usage', async () => {
    const { s } = await parseOk(file(MAIN))
    // input includes cached on the wire; frisk keeps them apart.
    expect(s.tokens['gpt-5.5']).toEqual({
      input: 200 + 200 + 300,
      output: 100 + 150 + 200,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 800 + 1000 + 1200,
    })
    expect(Object.keys(s.messageUsage)).toEqual(['u1', 'u2', 'u3'])
    expect(s.steps.map((st) => st.messageId)).toEqual([
      'u1',
      'u2',
      'u2',
      'u2',
      'u3',
    ])
    expect(s.bashRuns.map((r) => r.messageId)).toEqual(['u1', 'u2'])
    expect(s.models).toEqual(['gpt-5.5'])
  })

  test('an interrupt at the end marks the session and its last turn', async () => {
    const { s } = await parseOk(file(MAIN))
    expect(s.interrupts).toBe(1)
    expect(s.endedAfterInterrupt).toBe(true)
    expect(s.interruptedTurnMessageIds).toEqual(['u3'])
  })

  test('prefers token_usage_record over token_count and reads the IDE wrapper', async () => {
    const { s } = await parseOk(file(NEW))
    expect(s.entrypoint).toBe('vscode')
    expect(s.prompts.map((p) => p.text)).toEqual(['Rename the App component'])
    expect(s.tokens['gpt-5.6-terra']).toMatchObject({
      input: 500,
      cacheRead: 1500,
      output: 300,
    })
    expect(Object.keys(s.messageUsage)).toEqual(['resp_1'])
    expect(s.steps.map((st) => [st.detail, st.isError, st.messageId])).toEqual([
      ['tsx', true, 'resp_1'],
    ])
  })

  test('older rollouts with user_message events count each prompt once', async () => {
    const { s } = await parseOk(file(OLD))
    expect(s.prompts.map((p) => p.text)).toEqual(['Explain the build script'])
    expect(s.branch).toBeNull()
    expect(s.steps.map((st) => [st.tool, st.detail, st.isError])).toEqual([
      ['shell', 'file_ops', false],
    ])
  })

  test('visits typed and tool text, never injected context', async () => {
    const seen: TextVisit[] = []
    await parseOk(file(MAIN), (v) => seen.push(v))
    expect(seen.map((v) => [v.source, v.tool])).toEqual([
      ['typed-prompt', null],
      ['tool-input', 'exec_command:package_manager'],
      ['tool-output', 'exec_command:package_manager'],
      ['tool-input', 'apply_patch:ts'],
      ['tool-output', 'apply_patch:ts'],
      ['tool-input', 'shell:package_manager'],
      ['tool-output', 'shell:package_manager'],
      ['tool-input', 'spawn_agent:reviewer'],
      ['tool-output', 'spawn_agent:reviewer'],
      ['assistant-text', null],
      ['compact-summary', null],
      ['typed-prompt', null],
      ['tool-input', 'mcp:linear'],
      ['tool-output', 'mcp:linear'],
    ])
    expect(seen.some((v) => v.text.includes('environment_context'))).toBe(false)
    expect(seen.some((v) => v.text.includes('AGENTS.md'))).toBe(false)
    // The JSON wrapper is unwrapped to the output text.
    expect(
      seen.find(
        (v) => v.tool === 'shell:package_manager' && v.source === 'tool-output',
      )?.text,
    ).toBe('1 pass')
  })

  test('drops frisk-made and prompt-less rollouts', async () => {
    const self = await parseCodexSession(file('dddddddd'), emptyCounters())
    expect(self.status).toBe('frisk-self')
    const empty = await parseCodexSession(file('eeeeeeee'), emptyCounters())
    expect(empty.status).toBe('no-prompt')
  })
})

describe('discoverCodexFiles', () => {
  test('attaches subagent rollouts to their top-level session and drops orphans', async () => {
    const files = await discoverCodexFiles(ROOT)
    expect(files.map((f) => f.sessionId).sort()).toEqual(
      [
        MAIN,
        OLD,
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        NEW,
      ].sort(),
    )
    const main = files.find((f) => f.sessionId === MAIN)!
    expect(
      main.subagentPaths.map((p) => p.split('-').slice(-5).join('-')),
    ).toEqual([
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc.jsonl',
    ])
  })

  test('a missing root yields nothing', async () => {
    expect(await discoverCodexFiles(join(ROOT, 'nope'))).toEqual([])
  })

  test('reads zstd-compressed rollouts the same as plain ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frisk-codex-'))
    tmp.push(dir)
    const day = join(dir, '2026', '11', '05')
    mkdirSync(day, { recursive: true })
    for (const name of readdirSync(DAY)) {
      const bytes = Bun.zstdCompressSync(readFileSync(join(DAY, name)))
      writeFileSync(join(day, `${name}.zst`), bytes)
    }
    const plain = await loadSessions([{ source: codexSource, root: ROOT }], {
      sinceMs: 0,
    })
    const zst = await loadSessions([{ source: codexSource, root: dir }], {
      sinceMs: 0,
    })
    const strip = (ss: Session[]) => ss.map((s) => ({ ...s }))
    expect(strip(zst.sessions)).toEqual(strip(plain.sessions))
    expect(zst.stats.subagentFiles).toBe(2)
  })
})

describe('loadSessions with Codex', () => {
  test('skips frisk-made and prompt-less sessions and rolls up subagent usage', async () => {
    const { sessions, stats } = await loadSessions(
      [{ source: codexSource, root: ROOT }],
      { sinceMs: 0 },
    )
    expect(stats.files).toBe(5)
    expect(stats.skippedFriskSelf).toBe(1)
    expect(stats.skippedNoPrompt).toBe(1)
    expect(stats.subagentFiles).toBe(2)
    expect(stats.byAgent).toEqual({ codex: { files: 5, sessions: 3 } })
    expect(sessions.map((s) => s.id)).toEqual([OLD, NEW, MAIN])
    const main = sessions.find((s) => s.id === MAIN)!
    expect(main.subagents.count).toBe(2)
    expect(main.subagents.tokens['gpt-5.4-mini']).toMatchObject({
      input: 1000,
      output: 100,
    })
    expect(main.models).toEqual(['gpt-5.4-mini', 'gpt-5.5'])
  })

  test('subagent text is scanned as subagent', async () => {
    const sources: string[] = []
    await loadSessions([{ source: codexSource, root: ROOT }], {
      sinceMs: 0,
      project: 'codex-demo',
      textVisitor: () => (v) => sources.push(v.source),
    })
    expect(sources).toContain('subagent')
  })
})
