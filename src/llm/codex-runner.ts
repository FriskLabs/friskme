import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 * Every call is isolated, as far as `codex exec` allows:
 * - `--ephemeral`: no rollout lands in the folder frisk reads.
 * - `--ignore-user-config`: none of the user's MCP servers, plugins, profiles
 *   or custom instructions load (login still works). `--ignore-rules` skips
 *   execpolicy rules.
 * - `project_doc_max_bytes=0`: no AGENTS.md is read.
 * - `web_search="disabled"`, `features.shell_tool=false`,
 *   `features.multi_agent=false`, `features.apps=false`,
 *   `features.view_image=false`, `features.memories=false`: the model gets
 *   nothing to act with. `--sandbox read-only` and `approval_policy="never"`
 *   back that up should a tool remain: it could not write and nobody is asked.
 * - `history.persistence="none"`: the prompt is not appended to history.
 * - An empty temp cwd (`--cd`), so no project file is in reach. The schema and
 *   the answer file live in a separate temp dir.
 *
 * `codex exec` has no system-prompt flag, so the system prompt is sent at the
 * top of stdin, right after the sentinel line.
 */
export function codexArgs(opts: {
  binary: string
  model: string | null
  cwd: string
  schemaPath: string
  outputPath: string
}): string[] {
  const config = [
    'approval_policy="never"',
    'web_search="disabled"',
    'project_doc_max_bytes=0',
    'history.persistence="none"',
    'features.shell_tool=false',
    'features.multi_agent=false',
    'features.apps=false',
    'features.view_image=false',
    'features.memories=false',
  ]
  return [
    opts.binary,
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--cd',
    opts.cwd,
    ...config.flatMap((c) => ['-c', c]),
    '--output-schema',
    opts.schemaPath,
    '--output-last-message',
    opts.outputPath,
    ...(opts.model ? ['--model', opts.model] : []),
    '-',
  ]
}

/** The stdin text: sentinel first (so frisk can always spot its own sessions), then the system prompt. */
export function codexStdin(systemPrompt: string, prompt: string): string {
  const body = prompt.startsWith(FRISK_SENTINEL)
    ? prompt.slice(FRISK_SENTINEL.length).replace(/^\n/, '')
    : prompt
  return `${FRISK_SENTINEL}\n${systemPrompt}\n\n${body}`
}

export class CodexRunner implements ModelRunner {
  readonly analyzer: AnalyzerId = 'codex'
  private readonly cwd: string
  private readonly io: string
  private seq = 0
  calls = 0
  failures = 0
  /** `codex exec` does not report cost. */
  costUsd: number | null = null

  constructor(
    private readonly opts: {
      binary: string
      model: string | null
      systemPrompt: string
      spawn?: SpawnFn
    },
  ) {
    this.cwd = mkdtempSync(join(tmpdir(), 'frisk-'))
    this.io = mkdtempSync(join(tmpdir(), 'frisk-io-'))
  }

  dispose(): void {
    rmSync(this.cwd, { recursive: true, force: true })
    rmSync(this.io, { recursive: true, force: true })
  }

  async run<T>(
    prompt: string,
    schema: object,
    validate: Validator<T>,
  ): Promise<RunOutcome<T>> {
    const spawn = this.opts.spawn ?? defaultSpawn
    const n = ++this.seq
    const schemaPath = join(this.io, `schema-${n}.json`)
    writeFileSync(schemaPath, JSON.stringify(schema))
    const stdin = codexStdin(this.opts.systemPrompt, prompt)
    let reason = ''
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        this.calls++
        const outputPath = join(this.io, `answer-${n}-${attempt}.json`)
        const args = codexArgs({
          binary: this.opts.binary,
          model: this.opts.model,
          cwd: this.cwd,
          schemaPath,
          outputPath,
        })
        let result: SpawnResult
        try {
          result = await spawn(args, stdin, { cwd: this.cwd })
        } catch (err) {
          reason = `spawn failed: ${err instanceof Error ? err.message : String(err)}`
          continue
        }
        const parsed = readAnswer(result, outputPath)
        rmSync(outputPath, { force: true })
        if (!parsed.ok) {
          reason = parsed.reason
          continue
        }
        const v = validate(parsed.value)
        if (v.ok)
          return { ok: true, value: v.value, attempts: attempt, costUsd: 0 }
        reason = `invalid output: ${v.reason}`
      }
    } finally {
      rmSync(schemaPath, { force: true })
    }
    this.failures++
    return { ok: false, reason, attempts: 2, costUsd: 0 }
  }
}

function readAnswer(
  r: SpawnResult,
  outputPath: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (r.exitCode !== 0) {
    const detail =
      (r.stderr || r.stdout).trim().split('\n').pop()?.slice(0, 200) ?? ''
    return { ok: false, reason: `codex exited ${r.exitCode}: ${detail}` }
  }
  let text: string
  try {
    text = readFileSync(outputPath, 'utf8')
  } catch {
    return { ok: false, reason: 'codex wrote no answer' }
  }
  // The answer should be bare JSON; tolerate a fenced block.
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    return { ok: true, value: JSON.parse(body) }
  } catch {
    return { ok: false, reason: 'answer was not valid JSON' }
  }
}
