import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AnalyzerId,
  defaultSpawn,
  type ModelRunner,
  type RunOutcome,
  type SpawnFn,
  type SpawnResult,
  type Validator,
} from './runner.ts'

export type { RunOutcome, SpawnFn, SpawnResult, Validator } from './runner.ts'
export { defaultSpawn } from './runner.ts'

/**
 * Every call is isolated:
 * - `--no-session-persistence`: no transcript lands in the folder frisk reads.
 * - `--tools ""`, `--disallowedTools mcp__*`, `--strict-mcp-config`,
 *   `--max-turns 1`: transcript text is untrusted, so the model gets nothing
 *   to act with.
 * - `--safe-mode`: no CLAUDE.md, hooks, plugins, skills or MCP servers, while
 *   subscription (OAuth) login keeps working. `--bare` would break that login.
 * - `--system-prompt`: replaces the default coding-agent prompt.
 * - An empty temp `cwd`, so no project file is in reach.
 */
export function claudeArgs(opts: {
  binary: string
  model: string
  systemPrompt: string
  schema: object
}): string[] {
  return [
    opts.binary,
    '-p',
    '--no-session-persistence',
    '--safe-mode',
    '--strict-mcp-config',
    '--tools',
    '',
    '--disallowedTools',
    'mcp__*',
    '--max-turns',
    '1',
    '--system-prompt',
    opts.systemPrompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(opts.schema),
    '--model',
    opts.model,
  ]
}

export class ClaudeRunner implements ModelRunner {
  readonly analyzer: AnalyzerId = 'claude'
  private readonly cwd: string
  calls = 0
  failures = 0
  costUsd = 0

  constructor(
    private readonly opts: {
      binary: string
      model: string
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
    const args = claudeArgs({ ...this.opts, schema })
    let reason = ''
    let cost = 0
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.calls++
      let result: SpawnResult
      try {
        result = await spawn(args, prompt, { cwd: this.cwd })
      } catch (err) {
        reason = `spawn failed: ${err instanceof Error ? err.message : String(err)}`
        continue
      }
      const parsed = parseResult(result)
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

function parseResult(
  r: SpawnResult,
):
  | { ok: true; value: unknown; costUsd: number }
  | { ok: false; reason: string; costUsd: number } {
  let envelope: any
  try {
    envelope = JSON.parse(r.stdout)
  } catch {
    const detail =
      (r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 200) ?? ''
    return {
      ok: false,
      reason:
        r.exitCode !== 0
          ? `claude exited ${r.exitCode}: ${detail}`
          : 'output was not JSON',
      costUsd: 0,
    }
  }
  const costUsd =
    typeof envelope?.total_cost_usd === 'number' ? envelope.total_cost_usd : 0
  if (r.exitCode !== 0 || envelope?.is_error === true) {
    const detail = String(envelope?.result ?? r.stderr ?? '').slice(0, 200)
    return {
      ok: false,
      reason: `claude exited ${r.exitCode}: ${detail}`,
      costUsd,
    }
  }
  if (
    envelope?.structured_output &&
    typeof envelope.structured_output === 'object'
  ) {
    return { ok: true, value: envelope.structured_output, costUsd }
  }
  if (typeof envelope?.result === 'string') {
    try {
      return { ok: true, value: JSON.parse(envelope.result), costUsd }
    } catch {
      return { ok: false, reason: 'result was not valid JSON', costUsd }
    }
  }
  return { ok: false, reason: 'no structured output in response', costUsd }
}
