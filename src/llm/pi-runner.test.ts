import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FRISK_SENTINEL } from '../constants.ts'
import {
  PI_ENV,
  PiRunner,
  parsePiEvents,
  piArgs,
  piStdin,
} from './pi-runner.ts'
import { checkAnalyzer, piDefaultProvider, preflight } from './preflight.ts'
import { parseAnalyzer, type SpawnFn, type SpawnResult } from './runner.ts'

// Never runs the real pi CLI: every call goes to a fake spawn.

/** pi's JSON event stream for one answer. */
function events(
  text: string,
  extra: Record<string, unknown> = {},
  costs: number[] = [0.002],
): string {
  const assistant = (cost: number, last: boolean) => ({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        ...(last ? [{ type: 'text', text }] : []),
      ],
      usage: { input: 1, output: 1, cost: { total: cost } },
      stopReason: last ? 'stop' : 'error',
      ...(last ? extra : {}),
    },
  })
  return [
    { type: 'session', version: 3, id: 'x', cwd: '/tmp' },
    { type: 'agent_start' },
    { type: 'message_end', message: { role: 'user', content: 'q' } },
    ...costs.map((c, i) => assistant(c, i === costs.length - 1)),
    { type: 'agent_settled', aborted: false },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n')
}

const ok = (stdout: string): SpawnResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
})

function fakePi(responses: SpawnResult[]) {
  const calls: {
    args: string[]
    stdin: string
    cwd: string
    env?: Record<string, string>
  }[] = []
  const spawn: SpawnFn = async (args, stdin, opts) => {
    calls.push({ args, stdin, cwd: opts.cwd, env: opts.env })
    const next = responses.shift()
    if (!next) throw new Error('no more fake responses')
    return next
  }
  return { spawn, calls }
}

const anyValue = (v: unknown) => ({ ok: true as const, value: v })

const tmp: string[] = []
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

describe('piArgs', () => {
  test('isolates the call', () => {
    const args = piArgs({ binary: '/bin/pi', model: null, systemPrompt: 'SYS' })
    expect(args[0]).toBe('/bin/pi')
    for (const flag of [
      '--print',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-mcp',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-approve',
      '--offline',
    ])
      expect(args).toContain(flag)
    expect(
      args.slice(args.indexOf('--mode'), args.indexOf('--mode') + 2),
    ).toEqual(['--mode', 'json'])
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SYS')
    expect(args[args.indexOf('--thinking') + 1]).toBe('off')
    expect(args).not.toContain('--model')
  })

  test('passes the model, and leaves a named thinking level alone', () => {
    const plain = piArgs({ binary: 'pi', model: 'haiku', systemPrompt: 's' })
    expect(plain.slice(-2)).toEqual(['--model', 'haiku'])
    expect(plain).toContain('--thinking')
    const leveled = piArgs({
      binary: 'pi',
      model: 'sonnet:low',
      systemPrompt: 's',
    })
    expect(leveled).not.toContain('--thinking')
  })
})

describe('piStdin', () => {
  test('sentinel first, once, then the prompt and the schema', () => {
    const s = piStdin(`${FRISK_SENTINEL}\nlabel these`, { type: 'object' })
    expect(s.startsWith(`${FRISK_SENTINEL}\nlabel these`)).toBe(true)
    expect(s.split(FRISK_SENTINEL)).toHaveLength(2)
    expect(s.endsWith('{"type":"object"}')).toBe(true)
    expect(piStdin('plain', {}).startsWith(`${FRISK_SENTINEL}\nplain`)).toBe(
      true,
    )
  })
})

describe('parsePiEvents', () => {
  test('reads the last assistant answer and sums cost across retries', () => {
    const r = parsePiEvents(ok(events('{"a":1}', {}, [0.001, 0.002])))
    expect(r).toEqual({ ok: true, value: { a: 1 }, costUsd: 0.003 })
  })

  test('tolerates a fenced answer and CRLF', () => {
    const stdout = events('```json\n{"a":2}\n```').replaceAll('\n', '\r\n')
    expect(parsePiEvents(ok(stdout))).toMatchObject({
      ok: true,
      value: { a: 2 },
    })
  })

  test('reports failures', () => {
    expect(parsePiEvents(ok(events('not json')))).toMatchObject({
      ok: false,
      reason: 'answer was not valid JSON',
    })
    expect(
      parsePiEvents(
        ok(events('', { stopReason: 'error', errorMessage: '401' })),
      ),
    ).toMatchObject({ ok: false, reason: 'pi call failed: 401' })
    expect(parsePiEvents(ok(''))).toMatchObject({
      ok: false,
      reason: 'pi returned no answer',
    })
    expect(
      parsePiEvents({ exitCode: 1, stdout: '', stderr: 'No API key\n' }),
    ).toMatchObject({ ok: false, reason: 'pi exited 1: No API key' })
  })
})

describe('PiRunner', () => {
  test('runs isolated in an empty folder, with telemetry off', async () => {
    const { spawn, calls } = fakePi([ok(events('{"items":[]}'))])
    const runner = new PiRunner({
      binary: '/bin/pi',
      model: 'haiku',
      systemPrompt: 'SYS',
      spawn,
    })
    const out = await runner.run(
      `${FRISK_SENTINEL}\nlabel`,
      { type: 'object' },
      anyValue,
    )
    expect(out).toEqual({
      ok: true,
      value: { items: [] },
      attempts: 1,
      costUsd: 0.002,
    })
    expect(calls[0]!.env).toEqual(PI_ENV)
    expect(calls[0]!.stdin.startsWith(FRISK_SENTINEL)).toBe(true)
    expect(calls[0]!.cwd).toContain('frisk-')
    expect(runner.costUsd).toBe(0.002)
    expect(runner.calls).toBe(1)
    runner.dispose()
  })

  test('retries once, then fails and still counts the cost', async () => {
    const { spawn } = fakePi([ok(events('nope')), ok(events('{"bad":1}'))])
    const runner = new PiRunner({
      binary: 'pi',
      model: null,
      systemPrompt: 's',
      spawn,
    })
    const out = await runner.run('p', {}, (v: any) =>
      v?.good
        ? { ok: true as const, value: v }
        : { ok: false as const, reason: 'no good' },
    )
    expect(out).toEqual({
      ok: false,
      reason: 'invalid output: no good',
      attempts: 2,
      costUsd: 0.004,
    })
    expect(runner.failures).toBe(1)
    expect(runner.costUsd).toBe(0.004)
    runner.dispose()
  })
})

describe('pi analyzer selection', () => {
  test('--analyzer pi parses; pi is never picked automatically', async () => {
    expect(parseAnalyzer('Pi')).toBe('pi')
    const which = (b: string) => (b === 'pi' ? '/bin/pi' : null)
    const pf = await preflight({ which })
    expect(pf.ok).toBe(false)
  })

  test('checks a provider-qualified --model, else pi default provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frisk-pi-cfg-'))
    tmp.push(dir)
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'x' }),
    )
    const env = { PI_CODING_AGENT_DIR: dir }
    expect(piDefaultProvider(env)).toBe('anthropic')
    const which = () => '/bin/pi'

    // A bare model id is not checked as such: pi would read it as any provider's.
    const a = fakePi([ok('ready\n')])
    expect(
      await checkAnalyzer('pi', {
        which,
        spawn: a.spawn,
        env,
        model: 'claude-haiku-5-5',
      }),
    ).toEqual({
      ok: true,
      analyzer: 'pi',
      binary: '/bin/pi',
      subscriptionType: null,
    })
    expect(a.calls[0]!.args).toEqual([
      '/bin/pi',
      'auth',
      'check',
      '--provider',
      'anthropic',
    ])
    expect(a.calls[0]!.env).toEqual({ PI_TELEMETRY: '0' })

    const b = fakePi([{ exitCode: 1, stdout: 'not_ready\n', stderr: '' }])
    const pf = await checkAnalyzer('pi', {
      which,
      spawn: b.spawn,
      env,
      model: 'openai/gpt-5.5',
    })
    expect(b.calls[0]!.args.slice(1)).toEqual([
      'auth',
      'check',
      '--model',
      'openai/gpt-5.5',
    ])
    expect(pf.ok ? '' : pf.message).toContain('pi auth login')
  })

  test('with no --model and no pi default, asks for --model', async () => {
    const { spawn, calls } = fakePi([])
    const pf = await checkAnalyzer('pi', {
      which: () => '/bin/pi',
      spawn,
      env: { PI_CODING_AGENT_DIR: '/does/not/exist' },
    })
    expect(pf.ok ? '' : pf.message).toContain('--model')
    expect(calls).toHaveLength(0)
  })
})
