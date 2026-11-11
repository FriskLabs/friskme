/**
 * What the label, group and skill passes need from a model: one structured
 * call at a time. `claude -p` and `codex exec` each implement it.
 */
import { spawn } from 'node:child_process'

export type SpawnResult = { exitCode: number; stdout: string; stderr: string }
export type SpawnFn = (
  args: string[],
  stdin: string,
  opts: { cwd: string },
) => Promise<SpawnResult>

export const defaultSpawn: SpawnFn = (args, stdin, opts) =>
  new Promise((resolve, reject) => {
    const [cmd, ...rest] = args
    if (!cmd) return reject(new Error('spawn: no command'))
    // No shell: the arguments carry JSON and multi-line text verbatim.
    const proc = spawn(cmd, rest, {
      cwd: opts.cwd,
      stdio: 'pipe',
      windowsHide: true,
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    proc.stdout.on('data', (c: Buffer) => out.push(c))
    proc.stderr.on('data', (c: Buffer) => err.push(c))
    proc.stdin.on('error', () => {
      // The child exited before reading stdin (EPIPE); its exit code tells the story.
    })
    proc.on('error', reject)
    proc.on('close', (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    )
    proc.stdin.end(stdin)
  })

export type RunOutcome<T> =
  | { ok: true; value: T; attempts: number; costUsd: number }
  | { ok: false; reason: string; attempts: number; costUsd: number }

export type Validator<T> = (
  value: unknown,
) => { ok: true; value: T } | { ok: false; reason: string }

export type AnalyzerId = 'claude' | 'codex'

export interface ModelRunner {
  readonly analyzer: AnalyzerId
  calls: number
  failures: number
  /** USD spent so far, or null when the CLI does not report cost. */
  costUsd: number | null
  /** One call, retried once on any failure (bad exit, bad JSON, invalid shape). */
  run<T>(
    prompt: string,
    schema: object,
    validate: Validator<T>,
  ): Promise<RunOutcome<T>>
  dispose(): void
}

export type AnalyzerInfo = {
  id: AnalyzerId
  /** The executable looked up on PATH. */
  binary: string
  /** How calls are named to the user: `claude -p`, `codex exec`. */
  callName: string
  /** Whose login the calls use. */
  loginName: string
  /** Default `--model`; null means the CLI's own default. */
  defaultModel: string | null
  loginHint: string
}

export const ANALYZERS: Record<AnalyzerId, AnalyzerInfo> = {
  claude: {
    id: 'claude',
    binary: 'claude',
    callName: 'claude -p',
    loginName: 'Claude',
    defaultModel: 'haiku',
    loginHint: 'claude auth login',
  },
  codex: {
    id: 'codex',
    binary: 'codex',
    callName: 'codex exec',
    loginName: 'Codex (ChatGPT or OpenAI API)',
    defaultModel: null,
    loginHint: 'codex login',
  },
}

export function parseAnalyzer(value: string): AnalyzerId {
  const v = value.trim().toLowerCase()
  if (v === 'claude' || v === 'codex') return v
  throw new Error(`--analyzer: expected claude or codex, got "${value}"`)
}

/** The model as shown to the user and as keyed in the cache. */
export function modelLabel(model: string | null): string {
  return model ?? 'the default model'
}

export function cacheModelKey(
  analyzer: AnalyzerId,
  model: string | null,
): string {
  return `${analyzer}/${model ?? 'default'}`
}
