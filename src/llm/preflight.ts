import type { SpawnFn } from './claude-runner.ts'
import { defaultSpawn } from './claude-runner.ts'

export type Preflight =
  | { ok: true; binary: string; subscriptionType: string | null }
  | { ok: false; message: string }

const NO_LLM_HINT =
  'Re-run with --no-llm to get the deterministic sections (overview, waste) without any model calls.'

/** Checks `claude` exists and is logged in. Reads only `loggedIn` and the plan type. */
export async function preflight(
  opts: { which?: (bin: string) => string | null; spawn?: SpawnFn } = {},
): Promise<Preflight> {
  const which = opts.which ?? ((b: string) => Bun.which(b))
  const spawn = opts.spawn ?? defaultSpawn
  const binary = which('claude')
  if (!binary) {
    return {
      ok: false,
      message: `The \`claude\` CLI was not found on your PATH. frisk uses it to label sessions.\n${NO_LLM_HINT}`,
    }
  }
  let result: Awaited<ReturnType<SpawnFn>>
  try {
    result = await spawn([binary, 'auth', 'status'], '', { cwd: process.cwd() })
  } catch {
    return {
      ok: false,
      message: `Could not run \`claude auth status\`.\n${NO_LLM_HINT}`,
    }
  }
  let status: any = null
  try {
    status = JSON.parse(result.stdout)
  } catch {
    status = null
  }
  if (result.exitCode !== 0 || status?.loggedIn === false) {
    return {
      ok: false,
      message: `\`claude\` is not logged in. Run \`claude auth login\`, then try again.\n${NO_LLM_HINT}`,
    }
  }
  return {
    ok: true,
    binary,
    subscriptionType:
      typeof status?.subscriptionType === 'string'
        ? status.subscriptionType
        : null,
  }
}
