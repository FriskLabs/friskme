import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandFamily } from '../../lib/command-family.ts'
import { emptyCounters, type TextVisit } from '../../parse/common.ts'
import {
  classifyUserText,
  parsePiSession,
  piModel,
  piTotals,
} from './build-session.ts'

const DIR = join(
  import.meta.dir,
  '..',
  '..',
  '__fixtures__',
  'pi',
  'sessions',
  '--tmp-demo--',
)
const MAIN = join(
  DIR,
  '2026-11-05T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl',
)
const SELF = join(
  DIR,
  '2026-11-05T11-00-00-000Z_33333333-3333-4333-8333-333333333333.jsonl',
)
const EMPTY = join(
  DIR,
  '2026-11-05T12-00-00-000Z_44444444-4444-4444-8444-444444444444.jsonl',
)

async function parseOk(path: string, onText?: (v: TextVisit) => void) {
  const counters = emptyCounters()
  const out = await parsePiSession(path, counters, onText)
  if (out.status !== 'ok') throw new Error(`expected ok, got ${out.status}`)
  return { s: out.session, counters }
}

const tmp: string[] = []
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

describe('piTotals', () => {
  test('splits cache writes by TTL and ignores junk', () => {
    expect(
      piTotals({
        input: 10,
        output: 100,
        cacheRead: 1000,
        cacheWrite: 500,
        cacheWrite1h: 200,
      }),
    ).toEqual({
      input: 10,
      output: 100,
      cacheWrite5m: 300,
      cacheWrite1h: 200,
      cacheRead: 1000,
    })
    expect(piTotals({ input: -1, output: 'x', cacheWrite1h: 9 })).toEqual({
      input: 0,
      output: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    })
  })
})

describe('piModel', () => {
  test('strips a vendor prefix', () => {
    expect(piModel('anthropic/claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(piModel('gpt-5.5')).toBe('gpt-5.5')
    expect(piModel('')).toBeNull()
    expect(piModel(undefined)).toBeNull()
  })
})

describe('classifyUserText', () => {
  test('reads /skill: expansions and typed text', () => {
    expect(
      classifyUserText(
        '<skill name="pdf" location="/s/SKILL.md">\nbody\n</skill>\n\nextract a.pdf',
      ),
    ).toEqual({ kind: 'skill', name: 'pdf', args: 'extract a.pdf' })
    expect(
      classifyUserText(
        '<skill name="pdf" location="/s/SKILL.md">\nbody\n</skill>',
      ),
    ).toEqual({ kind: 'skill', name: 'pdf', args: '' })
    expect(classifyUserText('  hi  ')).toEqual({ kind: 'typed', text: 'hi' })
    expect(classifyUserText('   ')).toBeNull()
  })
})

describe('parsePiSession', () => {
  test('folds the session header, prompts and skill commands', async () => {
    const { s } = await parseOk(MAIN)
    expect(s.id).toBe('11111111-1111-4111-8111-111111111111')
    expect(s.agent).toBe('pi')
    expect(s.projectLabel).toBe('demo')
    expect(s.branch).toBeNull()
    expect(s.start).toBe('2026-11-05T10:00:00.000Z')
    expect(s.end).toBe('2026-11-05T10:08:00.000Z')
    expect(s.prompts.map((p) => [p.source, p.text])).toEqual([
      ['typed', 'Fix the failing parser test'],
      ['command', '/skill:release ship 0.4.0'],
      ['typed', 'Now add a regression test'],
    ])
    expect(s.slashCommands).toEqual(['skill:release'])
  })

  test('maps tool calls onto steps and bash runs', async () => {
    const { s } = await parseOk(MAIN)
    expect(
      s.steps.map((t) => [t.tool, t.kind, t.detail, t.isError, t.messageId]),
    ).toEqual([
      ['bash', 'shell', commandFamily('bun test src/parse'), true, 'msg_1'],
      ['read', 'read', 'ts', false, 'msg_1'],
      ['edit', 'edit', 'ts', false, 'msg_2'],
      ['bash', 'shell', commandFamily('git push origin main'), false, 'msg_3'],
    ])
    expect(s.bashRuns).toEqual([
      { normalized: 'bun test src/parse', messageId: 'msg_1', isError: true },
      {
        normalized: 'git push origin main',
        messageId: 'msg_3',
        isError: false,
      },
    ])
    expect(s.errors).toBe(1)
  })

  test('counts interrupts and compactions', async () => {
    const { s } = await parseOk(MAIN)
    expect(s.interrupts).toBe(1)
    expect(s.interruptedTurnMessageIds).toEqual(['msg_3'])
    // A later prompt and reply follow the interrupt.
    expect(s.endedAfterInterrupt).toBe(false)
    expect(s.compactions).toBe(1)
  })

  test('totals usage by model, once per response', async () => {
    const { s } = await parseOk(MAIN)
    expect(s.models).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'gpt-5.5',
    ])
    // msg_1 + msg_2 + msg_3 + compaction + branch summary.
    expect(s.tokens['claude-opus-5-5']).toEqual({
      input: 10 + 5 + 3 + 2000 + 100,
      output: 100 + 50 + 7 + 300 + 20,
      cacheWrite5m: 300,
      cacheWrite1h: 200,
      cacheRead: 1000,
    })
    // The cache-warm `usage` entry names its own model.
    expect(s.tokens['claude-sonnet-5-5']?.cacheRead).toBe(5000)
    // msg_4 is logged twice and counted once.
    expect(s.tokens['gpt-5.5']).toEqual({
      input: 1,
      output: 2,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    })
    expect(Object.keys(s.messageUsage).sort()).toEqual([
      'e0000013',
      'e0000014',
      'e0000015',
      'msg_1',
      'msg_2',
      'msg_3',
      'msg_4',
    ])
  })

  test('counts malformed, ignored and unknown lines', async () => {
    const { counters } = await parseOk(MAIN)
    expect(counters.malformedLines).toBe(1)
    expect(counters.ignoredLineTypes).toEqual({
      thinking_level_change: 1,
      custom_message: 1,
      label: 1,
    })
    expect(counters.unknownLineTypes).toEqual({ something_new: 1 })
  })

  test('visits text for the sensitive scan, never the system prompt', async () => {
    const seen: TextVisit[] = []
    await parseOk(MAIN, (v) => seen.push(v))
    const of = (source: string) =>
      seen.filter((v) => v.source === source).map((v) => [v.tool, v.text])
    expect(of('typed-prompt').map(([, t]) => t)).toEqual([
      'Fix the failing parser test',
      'Now add a regression test',
    ])
    expect(of('slash-command')).toEqual([[null, 'ship 0.4.0']])
    expect(of('tool-input')).toContainEqual([
      `bash:${commandFamily('bun test src/parse')}`,
      'bun test src/parse',
    ])
    expect(of('tool-input')).toContainEqual([null, 'echo hello'])
    expect(of('tool-output')).toContainEqual(['read:ts', 'export const a = 1'])
    expect(of('tool-output')).toContainEqual([null, 'hello'])
    expect(of('compact-summary')).toHaveLength(2)
    expect(of('assistant-text').map(([, t]) => t)).toContain(
      'Looking at the parser tests.',
    )
    const all = seen.map((v) => v.text).join('\n')
    expect(all).not.toContain('coding assistant running inside pi')
    expect(all).not.toContain('Run the tests first.')
    expect(all).not.toContain('Bump the version, tag, push.')
  })

  test('drops frisk-made and prompt-less sessions', async () => {
    expect((await parsePiSession(SELF, emptyCounters())).status).toBe(
      'frisk-self',
    )
    expect((await parsePiSession(EMPTY, emptyCounters())).status).toBe(
      'no-prompt',
    )
  })

  test('a fork counts only the entries it added', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frisk-pi-'))
    tmp.push(dir)
    const copied = readFileSync(MAIN, 'utf8').split('\n').slice(1, 7)
    const fork = join(
      dir,
      '2026-11-06T09-00-00-000Z_22222222-2222-4222-8222-222222222222.jsonl',
    )
    const header = {
      type: 'session',
      version: 3,
      id: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-11-06T09:00:00.000Z',
      cwd: '/tmp/demo',
      parentSession: MAIN,
    }
    const prompt = {
      type: 'message',
      id: 'b0000001',
      parentId: 'e0000005',
      timestamp: '2026-11-06T09:00:05.000Z',
      message: { role: 'user', content: 'Try a different fix', timestamp: 0 },
    }
    const reply = {
      type: 'message',
      id: 'b0000002',
      parentId: 'b0000001',
      timestamp: '2026-11-06T09:00:09.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'OK.' }],
        model: 'claude-opus-5-5',
        responseId: 'msg_9',
        usage: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'stop',
      },
    }
    const lines = [header, ...copied.map((l) => JSON.parse(l)), prompt, reply]
    writeFileSync(fork, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

    const { s } = await parseOk(fork)
    expect(s.id).toBe('22222222-2222-4222-8222-222222222222')
    expect(s.prompts.map((p) => p.text)).toEqual(['Try a different fix'])
    expect(s.steps).toEqual([])
    expect(s.tokens).toEqual({
      'claude-opus-5-5': {
        input: 7,
        output: 8,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
      },
    })
    expect(s.start).toBe('2026-11-06T09:00:00.000Z')

    // With the parent gone, the copied entries are all the fork has.
    const orphan = join(dir, 'orphan.jsonl')
    writeFileSync(
      orphan,
      `${[
        { ...header, parentSession: join(dir, 'missing.jsonl') },
        ...copied.map((l) => JSON.parse(l)),
      ]
        .map((l) => JSON.stringify(l))
        .join('\n')}\n`,
    )
    const { s: o } = await parseOk(orphan)
    expect(o.prompts.map((p) => p.text)).toEqual([
      'Fix the failing parser test',
    ])
    expect(o.steps).toHaveLength(2)
  })
})
