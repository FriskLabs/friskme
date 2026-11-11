/**
 * What the label, group and skill passes need from a model: one structured
 * call at a time. `claude -p` and `codex exec` each implement it.
 */

export type SpawnResult = { exitCode: number; stdout: string; stderr: string }
export type SpawnFn = (
  args: string[],
  stdin: string,
  opts: { cwd: string },
) => Promise<SpawnResult>

export const defaultSpawn: SpawnFn = async (args, stdin, opts) => {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

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
