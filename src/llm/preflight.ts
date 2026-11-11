import {
  ANALYZERS,
  type AnalyzerId,
  defaultSpawn,
  type SpawnFn,
} from './runner.ts'

export type Preflight =
  | {
      ok: true
      analyzer: AnalyzerId
      binary: string
      subscriptionType: string | null
    }
  | { ok: false; message: string }

const NO_LLM_HINT =
  'Re-run with --no-llm to get the deterministic sections (overview, waste) without any model calls.'

type Deps = { which?: (bin: string) => string | null; spawn?: SpawnFn }

/**
 * Checks one analyzer's CLI exists and is logged in. For Claude it reads only
 * `loggedIn` and the plan type from `claude auth status`; for Codex only the
 * exit code of `codex login status`.
 */
export async function checkAnalyzer(
  analyzer: AnalyzerId,
  deps: Deps = {},
): Promise<Preflight> {
  const which = deps.which ?? ((b: string) => Bun.which(b))
  const spawn = deps.spawn ?? defaultSpawn
  const info = ANALYZERS[analyzer]
  const binary = which(info.binary)
  if (!binary) {
    return {
      ok: false,
      message: `The \`${info.binary}\` CLI was not found on your PATH. frisk uses it to label sessions.\n${NO_LLM_HINT}`,
    }
  }
  const statusArgs =
    analyzer === 'claude' ? ['auth', 'status'] : ['login', 'status']
  let result: Awaited<ReturnType<SpawnFn>>
  try {
    result = await spawn([binary, ...statusArgs], '', { cwd: process.cwd() })
  } catch {
    return {
      ok: false,
      message: `Could not run \`${info.binary} ${statusArgs.join(' ')}\`.\n${NO_LLM_HINT}`,
    }
  }
  let status: any = null
  if (analyzer === 'claude') {
    try {
      status = JSON.parse(result.stdout)
    } catch {
      status = null
    }
  }
  if (result.exitCode !== 0 || status?.loggedIn === false) {
    return {
      ok: false,
      message: `\`${info.binary}\` is not logged in. Run \`${info.loginHint}\`, then try again.\n${NO_LLM_HINT}`,
    }
  }
  return {
    ok: true,
    analyzer,
    binary,
    subscriptionType:
      typeof status?.subscriptionType === 'string'
        ? status.subscriptionType
        : null,
  }
}

/**
 * The analyzer to label with. An explicit choice is checked as is. Otherwise
 * Claude is used when it is installed and logged in, then Codex; if neither
 * works, the Claude message is shown, since that was the first choice.
 */
export async function preflight(
  opts: Deps & { analyzer?: AnalyzerId } = {},
): Promise<Preflight> {
  if (opts.analyzer) return checkAnalyzer(opts.analyzer, opts)
  const claude = await checkAnalyzer('claude', opts)
  if (claude.ok) return claude
  const codex = await checkAnalyzer('codex', opts)
  if (codex.ok) return codex
  return {
    ok: false,
    message: `Neither \`claude\` nor \`codex\` is installed and logged in; frisk uses one of them to label sessions.\n${claude.message}`,
  }
}
