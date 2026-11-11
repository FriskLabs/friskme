import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cache, labelKey } from '../cache.ts'
import { FRISK_SENTINEL } from '../constants.ts'
import {
  ClaudeRunner,
  claudeArgs,
  type SpawnFn,
  type SpawnResult,
} from './claude-runner.ts'
import { CodexRunner } from './codex-runner.ts'
import { groupByCategory, OTHER_INTENT, runGroupPass } from './group-pass.ts'
import { LABEL_BATCH_SIZE, planLabels, runLabelPass } from './label-pass.ts'
import { preflight } from './preflight.ts'
import {
  groupValidator,
  labelValidator,
  PROMPT_VERSION,
  skillValidator,
} from './prompts.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frisk-test-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const envelope = (
  structured: unknown,
  extra: Record<string, unknown> = {},
): SpawnResult => ({
  exitCode: 0,
  stdout: JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.001,
    structured_output: structured,
    ...extra,
  }),
  stderr: '',
})

/** A fake `claude` that answers from a queue and records every call. */
function fakeSpawn(
  responses: (SpawnResult | ((stdin: string) => SpawnResult))[],
) {
  const calls: { args: string[]; stdin: string; cwd: string }[] = []
  const spawn: SpawnFn = async (args, stdin, opts) => {
    calls.push({ args, stdin, cwd: opts.cwd })
    const next = responses.shift()
    if (!next) throw new Error('no more fake responses')
    return typeof next === 'function' ? next(stdin) : next
  }
  return { spawn, calls }
}

const anyValue = (v: unknown) => ({ ok: true as const, value: v })

describe('claudeArgs', () => {
  test('isolates every call', () => {
    const args = claudeArgs({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 'sys',
      schema: { type: 'object' },
    })
    const flag = (name: string) => args[args.indexOf(name) + 1]
    expect(args).toContain('--no-session-persistence')
    expect(args).toContain('--safe-mode')
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--bare')
    expect(flag('--tools')).toBe('')
    expect(flag('--disallowedTools')).toBe('mcp__*')
    expect(flag('--max-turns')).toBe('1')
    expect(flag('--output-format')).toBe('json')
    expect(flag('--model')).toBe('haiku')
    expect(JSON.parse(flag('--json-schema')!)).toEqual({ type: 'object' })
  })
})

describe('ClaudeRunner', () => {
  test('success: returns structured_output, sends the prompt on stdin from an empty temp dir', async () => {
    const { spawn, calls } = fakeSpawn([envelope({ a: 1 })])
    const runner = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn,
    })
    const out = await runner.run('hello', {}, anyValue)
    expect(out).toMatchObject({ ok: true, value: { a: 1 }, attempts: 1 })
    expect(calls[0]!.stdin).toBe('hello')
    expect(calls[0]!.args.join(' ')).not.toContain('hello')
    expect(calls[0]!.cwd).toContain('frisk-')
    expect(runner.costUsd).toBeCloseTo(0.001)
    runner.dispose()
  })

  test('falls back to parsing `result` when structured_output is missing', async () => {
    const { spawn } = fakeSpawn([
      {
        exitCode: 0,
        stdout: JSON.stringify({ is_error: false, result: '{"b":2}' }),
        stderr: '',
      },
    ])
    const runner = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn,
    })
    expect(await runner.run('x', {}, anyValue)).toMatchObject({
      ok: true,
      value: { b: 2 },
    })
    runner.dispose()
  })

  test('invalid JSON is retried once and then succeeds', async () => {
    const { spawn, calls } = fakeSpawn([
      { exitCode: 0, stdout: 'not json', stderr: '' },
      envelope({ a: 1 }),
    ])
    const runner = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn,
    })
    expect(await runner.run('x', {}, anyValue)).toMatchObject({
      ok: true,
      attempts: 2,
    })
    expect(calls).toHaveLength(2)
    runner.dispose()
  })

  test('output that fails validation twice is a failure, not a silent drop', async () => {
    const { spawn } = fakeSpawn([envelope({ nope: 1 }), envelope({ nope: 2 })])
    const runner = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn,
    })
    const out = await runner.run('x', {}, () => ({
      ok: false,
      reason: 'bad shape',
    }))
    expect(out).toMatchObject({ ok: false, attempts: 2 })
    expect(out.ok ? '' : out.reason).toContain('bad shape')
    expect(runner.failures).toBe(1)
    runner.dispose()
  })

  test('non-zero exit is reported with the error text', async () => {
    const fail: SpawnResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'API Error: 529 overloaded',
    }
    const { spawn } = fakeSpawn([fail, fail])
    const runner = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn,
    })
    const out = await runner.run('x', {}, anyValue)
    expect(out.ok).toBe(false)
    expect(out.ok ? '' : out.reason).toBe(
      'claude exited 1: API Error: 529 overloaded',
    )
    runner.dispose()
  })

  test('an is_error envelope counts as a failure', async () => {
    const err = {
      exitCode: 0,
      stdout: JSON.stringify({ is_error: true, result: 'Not logged in' }),
      stderr: '',
    }
    const { spawn } = fakeSpawn([err, err])
    const runner = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn,
    })
    expect((await runner.run('x', {}, anyValue)).ok).toBe(false)
    runner.dispose()
  })
})

describe('preflight', () => {
  test('a Windows .cmd shim is refused before it is run', async () => {
    const { spawn, calls } = fakeSpawn([])
    const pf = await preflight({
      analyzer: 'claude',
      which: () => 'C:\\npm\\claude.cmd',
      spawn,
    })
    expect(pf.ok).toBe(false)
    expect(pf.ok ? '' : pf.message).toContain('.exe')
    expect(calls).toHaveLength(0)
  })

  test('missing claude binary', async () => {
    const pf = await preflight({ analyzer: 'claude', which: () => null })
    expect(pf.ok).toBe(false)
    expect(pf.ok ? '' : pf.message).toContain('--no-llm')
  })

  test('not logged in: non-zero exit', async () => {
    const { spawn } = fakeSpawn([
      { exitCode: 1, stdout: '{"loggedIn":false}', stderr: '' },
    ])
    const pf = await preflight({
      analyzer: 'claude',
      which: () => '/bin/claude',
      spawn,
    })
    expect(pf.ok).toBe(false)
    expect(pf.ok ? '' : pf.message).toContain('claude auth login')
  })

  test('not logged in: zero exit but loggedIn false', async () => {
    const { spawn } = fakeSpawn([
      { exitCode: 0, stdout: '{"loggedIn":false}', stderr: '' },
    ])
    expect(
      (
        await preflight({
          analyzer: 'claude',
          which: () => '/bin/claude',
          spawn,
        })
      ).ok,
    ).toBe(false)
  })

  test('logged in', async () => {
    const { spawn, calls } = fakeSpawn([
      {
        exitCode: 0,
        stdout: '{"loggedIn":true,"subscriptionType":"max","email":"x@y.z"}',
        stderr: '',
      },
    ])
    expect(await preflight({ which: () => '/bin/claude', spawn })).toEqual({
      ok: true,
      analyzer: 'claude',
      binary: '/bin/claude',
      subscriptionType: 'max',
    })
    expect(calls[0]!.args).toEqual(['/bin/claude', 'auth', 'status'])
  })

  test('falls back to codex when claude is missing', async () => {
    const { spawn, calls } = fakeSpawn([
      { exitCode: 0, stdout: 'Logged in using ChatGPT', stderr: '' },
    ])
    const pf = await preflight({
      which: (b) => (b === 'codex' ? '/bin/codex' : null),
      spawn,
    })
    expect(pf).toEqual({
      ok: true,
      analyzer: 'codex',
      binary: '/bin/codex',
      subscriptionType: null,
    })
    expect(calls[0]!.args).toEqual(['/bin/codex', 'login', 'status'])
  })

  test('codex not logged in names its login command', async () => {
    const { spawn } = fakeSpawn([
      { exitCode: 1, stdout: '', stderr: 'Not logged in' },
    ])
    const pf = await preflight({
      analyzer: 'codex',
      which: () => '/bin/codex',
      spawn,
    })
    expect(pf.ok ? '' : pf.message).toContain('codex login')
  })

  test('neither analyzer available', async () => {
    const pf = await preflight({ which: () => null })
    expect(pf.ok ? '' : pf.message).toContain('Neither `claude` nor `codex`')
  })
})

describe('CodexRunner', () => {
  const answer =
    (value: unknown, exitCode = 0) =>
    (args: string[]): SpawnResult => {
      const out = args[args.indexOf('--output-last-message') + 1]!
      if (exitCode === 0) writeFileSync(out, JSON.stringify(value))
      return { exitCode, stdout: '', stderr: exitCode ? 'boom\nlast line' : '' }
    }

  function fakeCodex(responses: ((args: string[]) => SpawnResult)[]) {
    const calls: { args: string[]; stdin: string; cwd: string }[] = []
    const spawn: SpawnFn = async (args, stdin, opts) => {
      calls.push({ args, stdin, cwd: opts.cwd })
      const next = responses.shift()
      if (!next) throw new Error('no more fake responses')
      return next(args)
    }
    return { spawn, calls }
  }
  const anyValue = (v: unknown) => ({ ok: true as const, value: v })

  test('runs isolated, schema on disk, prompt and system prompt on stdin', async () => {
    const { spawn, calls } = fakeCodex([answer({ items: [] })])
    const runner = new CodexRunner({
      binary: '/bin/codex',
      model: null,
      systemPrompt: 'SYSTEM',
      spawn,
    })
    const schema = { type: 'object' }
    let schemaSeen: unknown = null
    const out = await runner.run(
      `${FRISK_SENTINEL}\nlabel these`,
      schema,
      (v) => {
        schemaSeen = JSON.parse(
          readFileSync(
            calls[0]!.args[calls[0]!.args.indexOf('--output-schema') + 1]!,
            'utf8',
          ),
        )
        return anyValue(v)
      },
    )
    expect(out).toEqual({
      ok: true,
      value: { items: [] },
      attempts: 1,
      costUsd: 0,
    })
    expect(schemaSeen).toEqual(schema)
    const { args, stdin, cwd } = calls[0]!
    expect(args.slice(0, 2)).toEqual(['/bin/codex', 'exec'])
    for (const flag of [
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
    ]) {
      expect(args).toContain(flag)
    }
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(args[args.indexOf('--cd') + 1]).toBe(cwd)
    for (const c of [
      'web_search="disabled"',
      'project_doc_max_bytes=0',
      'features.shell_tool=false',
      'approval_policy="never"',
      'history.persistence="none"',
    ]) {
      expect(args).toContain(c)
    }
    expect(args).not.toContain('--model')
    expect(args.at(-1)).toBe('-')
    expect(readdirSync(cwd)).toEqual([])
    expect(stdin.startsWith(`${FRISK_SENTINEL}\nSYSTEM\n\nlabel these`)).toBe(
      true,
    )
    expect(runner.costUsd).toBeNull()
    runner.dispose()
  })

  test('passes the model and retries once on failure', async () => {
    const { spawn, calls } = fakeCodex([answer(null, 1), answer({ ok: 1 })])
    const runner = new CodexRunner({
      binary: 'codex',
      model: 'gpt-5.4',
      systemPrompt: 'S',
      spawn,
    })
    const out = await runner.run('x', {}, anyValue)
    expect(out.ok && out.attempts).toBe(2)
    expect(calls[0]!.args[calls[0]!.args.indexOf('--model') + 1]).toBe(
      'gpt-5.4',
    )
    expect(runner.calls).toBe(2)
    runner.dispose()
  })

  test('reports the last stderr line when both attempts fail', async () => {
    const { spawn } = fakeCodex([answer(null, 1), answer(null, 1)])
    const runner = new CodexRunner({
      binary: 'codex',
      model: null,
      systemPrompt: 'S',
      spawn,
    })
    const out = await runner.run('x', {}, anyValue)
    expect(out).toMatchObject({
      ok: false,
      reason: 'codex exited 1: last line',
    })
    expect(runner.failures).toBe(1)
    runner.dispose()
  })

  test('accepts a fenced JSON answer and rejects prose', async () => {
    const fenced = (args: string[]): SpawnResult => {
      writeFileSync(
        args[args.indexOf('--output-last-message') + 1]!,
        '```json\n{"a":1}\n```',
      )
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const prose = (args: string[]): SpawnResult => {
      writeFileSync(
        args[args.indexOf('--output-last-message') + 1]!,
        'Sure! Here it is.',
      )
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const { spawn } = fakeCodex([fenced, prose, prose])
    const runner = new CodexRunner({
      binary: 'codex',
      model: null,
      systemPrompt: 'S',
      spawn,
    })
    expect(await runner.run('x', {}, anyValue)).toMatchObject({
      ok: true,
      value: { a: 1 },
    })
    expect(await runner.run('x', {}, anyValue)).toMatchObject({
      ok: false,
      reason: 'answer was not valid JSON',
    })
    runner.dispose()
  })
})

describe('validators', () => {
  test('labelValidator keeps good items and reports the rest', () => {
    const v = labelValidator(['s1', 's2', 's3'])({
      items: [
        {
          id: 's1',
          intent: 'Fix flaky login test.',
          category: 'fix bug',
          summary: 'x',
        },
        {
          id: '[s2]',
          intent: 'one two three four five six seven eight nine',
          category: 'fix bug',
          summary: 'x',
        },
        {
          id: 's3',
          intent: 'Write docs',
          category: 'not-a-category',
          summary: 'x',
        },
        { id: 's9', intent: 'Unknown id', category: 'other', summary: 'x' },
      ],
    })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.value.items).toEqual([
      {
        id: 's1',
        intent: 'Fix flaky login test',
        category: 'fix bug',
        summary: 'x',
      },
    ])
    expect(v.value.failedIds).toEqual(['s2', 's3'])
  })

  test('labelValidator rejects a response with nothing usable', () => {
    expect(labelValidator(['s1'])({ items: [] }).ok).toBe(false)
    expect(labelValidator(['s1'])({}).ok).toBe(false)
  })

  test('groupValidator matches labels case-insensitively, keeps first assignment, reports leftovers', () => {
    const v = groupValidator(['Fix login', 'Add tests', 'Deploy app'])({
      intents: [
        {
          name: 'Auth work',
          description: 'd',
          labels: ['fix login', 'Invented label'],
        },
        {
          name: 'Testing',
          description: 'd',
          labels: ['Add tests', 'Fix login'],
        },
      ],
    })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.value.intents.map((i) => [i.name, i.labels])).toEqual([
      ['Auth work', ['Fix login']],
      ['Testing', ['Add tests']],
    ])
    expect(v.value.unassigned).toEqual(['Deploy app'])
  })

  test('skillValidator requires a name, description and steps', () => {
    expect(
      skillValidator({
        name: 'x',
        description: 'd',
        whenToUse: '',
        steps: ['a', 'b'],
        notes: '',
      }).ok,
    ).toBe(true)
    expect(
      skillValidator({ name: 'x', description: 'd', steps: ['a'] }).ok,
    ).toBe(false)
    expect(skillValidator({ description: 'd', steps: ['a', 'b'] }).ok).toBe(
      false,
    )
  })
})

describe('label pass + cache', () => {
  const jobs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: `sess-${i}`,
      card: `card ${i}`,
    }))
  const labelAll = (stdin: string): SpawnResult => {
    const ids = [...stdin.matchAll(/^\[(s\d+)\]/gm)].map((m) => m[1])
    return envelope({
      items: ids.map((id) => ({
        id,
        intent: `Do task ${id}`,
        category: 'build feature',
        summary: 'x',
      })),
    })
  }

  test('labels in batches of 30, every prompt starts with the sentinel, and never sends session ids', async () => {
    const { spawn, calls } = fakeSpawn([labelAll, labelAll])
    const runner = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn,
    })
    const cache = new Cache(dir)
    const res = await runLabelPass({
      jobs: jobs(LABEL_BATCH_SIZE + 5),
      runner,
      cache,
      model: 'haiku',
      concurrency: 4,
    })
    expect(calls).toHaveLength(2)
    expect(res.labels.size).toBe(35)
    expect(res.unlabeled).toEqual([])
    for (const c of calls) {
      expect(c.stdin.startsWith(FRISK_SENTINEL)).toBe(true)
      expect(c.stdin).not.toContain('sess-')
    }
    runner.dispose()
  })

  test('a re-run hits the cache and makes no calls', async () => {
    const cache = new Cache(dir)
    const first = fakeSpawn([labelAll])
    const r1 = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn: first.spawn,
    })
    await runLabelPass({
      jobs: jobs(3),
      runner: r1,
      cache,
      model: 'haiku',
      concurrency: 4,
    })
    const second = fakeSpawn([])
    const r2 = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn: second.spawn,
    })
    const res = await runLabelPass({
      jobs: jobs(3),
      runner: r2,
      cache,
      model: 'haiku',
      concurrency: 4,
    })
    expect(second.calls).toHaveLength(0)
    expect(res.cached).toBe(3)
    expect(res.labels.get('sess-1')?.intent).toBe('Do task s2')
    r1.dispose()
    r2.dispose()
  })

  test('a changed card or model misses the cache', () => {
    const cache = new Cache(dir)
    cache.set('labels', labelKey('a', 'card', 'haiku', PROMPT_VERSION), {
      intent: 'x',
      category: 'other',
      summary: '',
    })
    expect(
      planLabels([{ sessionId: 'a', card: 'card' }], cache, 'haiku').todo,
    ).toHaveLength(0)
    expect(
      planLabels([{ sessionId: 'a', card: 'card changed' }], cache, 'haiku')
        .todo,
    ).toHaveLength(1)
    expect(
      planLabels([{ sessionId: 'a', card: 'card' }], cache, 'sonnet').todo,
    ).toHaveLength(1)
  })

  test('ids missing from a valid response are retried, and still-missing ones become unlabeled', async () => {
    const onlyFirst = (stdin: string): SpawnResult => {
      const id = /^\[(s\d+)\]/m.exec(stdin)![1]
      return envelope({
        items: [{ id, intent: 'Only one', category: 'other', summary: '' }],
      })
    }
    // First batch labels s1 only; the retry batch (2 cards) labels its s1 only.
    const { spawn, calls } = fakeSpawn([onlyFirst, onlyFirst])
    const runner = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn,
    })
    const res = await runLabelPass({
      jobs: jobs(3),
      runner,
      cache: new Cache(dir),
      model: 'haiku',
      concurrency: 1,
    })
    expect(calls).toHaveLength(2)
    expect(res.labels.size).toBe(2)
    expect(res.unlabeled).toEqual(['sess-2'])
    runner.dispose()
  })
})

describe('group pass', () => {
  const inputs = [
    { label: 'Fix login', count: 3, category: 'fix bug' },
    { label: 'Add tests', count: 2, category: 'write tests' },
  ]

  test('sends only labels and counts, and puts leftovers in Other', async () => {
    const { spawn, calls } = fakeSpawn([
      envelope({
        intents: [{ name: 'Auth', description: 'd', labels: ['Fix login'] }],
      }),
    ])
    const runner = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn,
    })
    const res = await runGroupPass({
      inputs,
      runner,
      cache: new Cache(dir),
      model: 'haiku',
    })
    expect(calls[0]!.stdin).toContain('Fix login | 3 | fix bug')
    expect(res.intents.map((i) => [i.name, i.labels])).toEqual([
      ['Auth', ['Fix login']],
      [OTHER_INTENT, ['Add tests']],
    ])
    expect(res.unassigned).toBe(1)
    runner.dispose()
  })

  test('falls back to categories after two failures, and does not cache the fallback', async () => {
    const bad: SpawnResult = { exitCode: 0, stdout: 'garbage', stderr: '' }
    const { spawn } = fakeSpawn([bad, bad])
    const runner = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn,
    })
    const cache = new Cache(dir)
    const res = await runGroupPass({ inputs, runner, cache, model: 'haiku' })
    expect(res.fellBackToCategories).toBe(true)
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name)
    expect([...res.intents].sort(byName)).toEqual(
      groupByCategory(inputs).sort(byName),
    )
    const again = fakeSpawn([
      envelope({
        intents: [
          { name: 'All', description: 'd', labels: ['Fix login', 'Add tests'] },
        ],
      }),
    ])
    const r2 = new ClaudeRunner({
      binary: 'claude',
      model: 'haiku',
      systemPrompt: 's',
      spawn: again.spawn,
    })
    expect(
      (await runGroupPass({ inputs, runner: r2, cache, model: 'haiku' }))
        .fellBackToCategories,
    ).toBe(false)
    runner.dispose()
    r2.dispose()
  })
})
