import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { piAgentDir } from '../agents/pi/index.ts'
import { which as findOnPath } from '../which.ts'
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

type Deps = {
  which?: (bin: string) => string | null
  spawn?: SpawnFn
  /** The `--model` the user passed; pi checks that model's provider. */
  model?: string | null
  env?: NodeJS.ProcessEnv
}

/** pi's `defaultProvider` setting, or null. Reads that one field only. */
export function piDefaultProvider(env: NodeJS.ProcessEnv): string | null {
  try {
    const settings = JSON.parse(
      readFileSync(join(piAgentDir(env), 'settings.json'), 'utf8'),
    )
    const p = settings?.defaultProvider
    return typeof p === 'string' && p ? p : null
  } catch {
    return null
  }
}

/**
 * The login check to run, or a message when there is nothing to check. pi
 * logs in per provider. `pi auth check --model` resolves a bare or fuzzy id
 * to any provider that lists it (`haiku` → amazon-bedrock), unlike a real
 * run, which prefers a provider with credentials. So a `--model` is checked
 * only when it names its provider (`anthropic/claude-haiku-5-5`); otherwise
 * the provider pi uses by default is checked.
 */
function statusCommand(
  analyzer: AnalyzerId,
  deps: Deps,
): { args: string[] } | { message: string } {
  if (analyzer === 'claude') return { args: ['auth', 'status'] }
  if (analyzer === 'codex') return { args: ['login', 'status'] }
  if (deps.model?.includes('/'))
    return { args: ['auth', 'check', '--model', deps.model] }
  const provider = piDefaultProvider(deps.env ?? process.env)
  if (provider) return { args: ['auth', 'check', '--provider', provider] }
  if (deps.model) return { args: ['auth', 'check', '--model', deps.model] }
  return {
    message: `pi has no default model set. Pass --model (for example \`--model claude-haiku-5-5\`), or pick one in pi first.\n${NO_LLM_HINT}`,
  }
}

/**
 * Checks one analyzer's CLI exists and is logged in. For Claude it reads only
 * `loggedIn` and the plan type from `claude auth status`; for Codex only the
 * exit code of `codex login status`; for pi only the exit code of
 * `pi auth check` (0 means ready).
 */
export async function checkAnalyzer(
  analyzer: AnalyzerId,
  deps: Deps = {},
): Promise<Preflight> {
  const which = deps.which ?? ((b: string) => findOnPath(b))
  const spawn = deps.spawn ?? defaultSpawn
  const info = ANALYZERS[analyzer]
  const binary = which(info.binary)
  if (!binary) {
    return {
      ok: false,
      message: `The \`${info.binary}\` CLI was not found on your PATH. friskme uses it to label sessions.\n${NO_LLM_HINT}`,
    }
  }
  // Windows runs .cmd/.bat shims only through cmd.exe, which would mangle the
  // JSON schema and multi-line prompts frisk passes as arguments.
  if (/\.(cmd|bat)$/i.test(binary)) {
    return {
      ok: false,
      message: `Found ${binary}, a script shim; friskme needs the native \`${info.binary}\` executable (.exe) on Windows.\n${NO_LLM_HINT}`,
    }
  }
  const status0 = statusCommand(analyzer, deps)
  if ('message' in status0) return { ok: false, message: status0.message }
  const statusArgs = status0.args
  let result: Awaited<ReturnType<SpawnFn>>
  try {
    result = await spawn([binary, ...statusArgs], '', {
      cwd: process.cwd(),
      ...(analyzer === 'pi' ? { env: { PI_TELEMETRY: '0' } } : {}),
    })
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
 * works, the Claude message is shown, since that was the first choice. pi is
 * never picked on its own: its default model is whatever the user chats
 * with, which can cost far more per call than a labeling model.
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
    message: `Neither \`claude\` nor \`codex\` is installed and logged in; friskme uses one of them to label sessions.\n${claude.message}`,
  }
}
