import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FRISK_SENTINEL } from '../constants.ts'
import {
  type AnalyzerId,
  defaultSpawn,
  type ModelRunner,
  type RunOutcome,
  type SpawnFn,
  type SpawnResult,
  type Validator,
} from './runner.ts'

/**
 * Every call is isolated:
 * - `--no-session`: an in-memory session, so no file lands in the folder
 *   frisk reads.
 * - `--no-tools`: no built-in, extension, custom or MCP tool; transcript text
 *   is untrusted, so the model gets nothing to act with.
 * - `--no-extensions`, `--no-mcp`, `--no-skills`, `--no-prompt-templates`,
 *   `--no-themes`, `--no-context-files`: none of the user's extensions, MCP
 *   servers, skills, templates or AGENTS.md/CLAUDE.md load. `--no-approve`
 *   ignores trust-gated project files. Login still works.
 * - `--offline` and `PI_TELEMETRY=0`: no catalog refresh, version check or
 *   install telemetry; only the model call goes out.
 * - `--system-prompt`: replaces pi's coding-agent prompt.
 * - `--thinking off`, unless the model names a level (`model:high`).
 * - An empty temp cwd, and the prompt on stdin.
 *
 * pi has no structured-output flag, so the schema rides at the end of the
 * prompt and the answer is validated like any other.
 */
export function piArgs(opts: {
  binary: string
  model: string | null
  systemPrompt: string
}): string[] {
  const levelInModel = opts.model !== null && /:[a-z]+$/i.test(opts.model)
  return [
    opts.binary,
    '--print',
    '--mode',
    'json',
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
    '--system-prompt',
    opts.systemPrompt,
    ...(levelInModel ? [] : ['--thinking', 'off']),
    ...(opts.model ? ['--model', opts.model] : []),
  ]
}

export const PI_ENV = { PI_TELEMETRY: '0', PI_OFFLINE: '1' }

/** The stdin text: sentinel first (so frisk can always spot its own sessions), then the prompt and the schema. */
export function piStdin(prompt: string, schema: object): string {
  const body = prompt.startsWith(FRISK_SENTINEL)
    ? prompt.slice(FRISK_SENTINEL.length).replace(/^\n/, '')
    : prompt
  return `${FRISK_SENTINEL}\n${body}\n\nAnswer with one JSON object, and nothing else, that matches this JSON Schema:\n${JSON.stringify(schema)}`
}

export class PiRunner implements ModelRunner {
  readonly analyzer: AnalyzerId = 'pi'
  private readonly cwd: string
  calls = 0
  failures = 0
  costUsd = 0

  constructor(
    private readonly opts: {
      binary: string
      model: string | null
      systemPrompt: string
      spawn?: SpawnFn
    },
  ) {
    this.cwd = mkdtempSync(join(tmpdir(), 'frisk-'))
  }

  dispose(): void {
    rmSync(this.cwd, { recursive: true, force: true })
  }

  /** One call, retried once on any failure (bad exit, bad JSON, invalid shape). */
  async run<T>(
    prompt: string,
    schema: object,
    validate: Validator<T>,
  ): Promise<RunOutcome<T>> {
    const spawn = this.opts.spawn ?? defaultSpawn
    const args = piArgs(this.opts)
    const stdin = piStdin(prompt, schema)
    let reason = ''
    let cost = 0
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.calls++
      let result: SpawnResult
      try {
        result = await spawn(args, stdin, { cwd: this.cwd, env: PI_ENV })
      } catch (err) {
        reason = `spawn failed: ${err instanceof Error ? err.message : String(err)}`
        continue
      }
      const parsed = parsePiEvents(result)
      cost += parsed.costUsd
      if (!parsed.ok) {
        reason = parsed.reason
        continue
      }
      const v = validate(parsed.value)
      if (v.ok) {
        this.costUsd += cost
        return { ok: true, value: v.value, attempts: attempt, costUsd: cost }
      }
      reason = `invalid output: ${v.reason}`
    }
    this.failures++
    this.costUsd += cost
    return { ok: false, reason, attempts: 2, costUsd: cost }
  }
}

/**
 * Reads pi's JSON event stream: one record per LF-terminated line. The answer
 * is the text of the last completed assistant message; the cost is the sum
 * over every assistant message, pi's own retries included.
 */
export function parsePiEvents(
  r: SpawnResult,
):
  | { ok: true; value: unknown; costUsd: number }
  | { ok: false; reason: string; costUsd: number } {
  let costUsd = 0
  let last: any = null
  for (const raw of r.stdout.split('\n')) {
    const line = raw.replace(/\r$/, '').trim()
    if (!line) continue
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev?.type !== 'message_end' || ev.message?.role !== 'assistant') continue
    const c = ev.message.usage?.cost?.total
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) costUsd += c
    last = ev.message
  }
  if (r.exitCode !== 0) {
    const detail = String(
      last?.errorMessage ??
        (r.stderr || r.stdout).trim().split('\n').pop() ??
        '',
    ).slice(0, 200)
    return { ok: false, reason: `pi exited ${r.exitCode}: ${detail}`, costUsd }
  }
  if (!last) return { ok: false, reason: 'pi returned no answer', costUsd }
  if (last.stopReason === 'error' || last.stopReason === 'aborted') {
    const detail = String(last.errorMessage ?? last.stopReason).slice(0, 200)
    return { ok: false, reason: `pi call failed: ${detail}`, costUsd }
  }
  const text = (Array.isArray(last.content) ? last.content : [])
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('')
  // The answer should be bare JSON; tolerate a fenced block.
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return { ok: true, value: JSON.parse(body), costUsd }
  } catch {
    return { ok: false, reason: 'answer was not valid JSON', costUsd }
  }
}
