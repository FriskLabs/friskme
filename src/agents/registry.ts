import { existsSync } from 'node:fs'
import type { AgentId } from '../types.ts'
import { claudeSource } from './claude/index.ts'
import { codexSource } from './codex/index.ts'
import type { AgentSource, SourceRoot } from './types.ts'

/** Every agent frisk can read, in display order. */
export const ALL_AGENTS: readonly AgentSource[] = [claudeSource, codexSource]

export function agentById(id: AgentId): AgentSource | undefined {
  return ALL_AGENTS.find((a) => a.id === id)
}

export function agentName(id: AgentId): string {
  return agentById(id)?.displayName ?? id
}

/** Parses `--agent claude,codex`. Throws on an unknown or unsupported id. */
export function parseAgentList(value: string): AgentId[] {
  const ids = value
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
  if (ids.length === 0) throw new Error('--agent: expected at least one agent')
  const known = ALL_AGENTS.map((a) => a.id)
  for (const id of ids) {
    if (!agentById(id as AgentId)) {
      throw new Error(
        `--agent: unknown agent "${id}"; expected one of ${known.join(', ')}`,
      )
    }
  }
  return [...new Set(ids)] as AgentId[]
}

/**
 * The sources to scan and where. With no explicit list, every agent whose
 * session directory exists; with one, those agents even if their directory is
 * missing (it then yields no files, which the scan reports).
 */
export function resolveSources(
  env: NodeJS.ProcessEnv,
  only?: AgentId[],
): SourceRoot[] {
  const picked = only
    ? ALL_AGENTS.filter((a) => only.includes(a.id))
    : ALL_AGENTS
  return picked
    .map((source) => ({ source, root: source.defaultRoot(env) }))
    .filter(({ root }) => only !== undefined || existsSync(root))
}
