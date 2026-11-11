import type {
  FileCounters,
  ParseOutcome,
  TextVisitor,
} from '../parse/common.ts'
import type { AgentId, TokenTotals } from '../types.ts'

export type { AgentId } from '../types.ts'

/** One top-level session file, plus the files of the subagents it spawned. */
export type SessionFile = {
  path: string
  /** The session id, as the adapter resolves it (file name, header line, …). */
  sessionId: string
  mtimeMs: number
  subagentPaths: string[]
}

/**
 * One coding agent frisk can read. Adding an agent means writing one of these
 * under `src/agents/<id>/` and listing it in `registry.ts`. Everything after
 * parsing (cards, labels, waste, report) works on the agent-neutral `Session`.
 *
 * Adapters are read-only: they may list, stat and read, never write.
 */
export interface AgentSource {
  id: AgentId
  /** Shown in the terminal and the report: 'Claude Code', 'Codex'. */
  displayName: string
  /** Where this agent keeps its sessions, honoring the agent's own env override. */
  defaultRoot(env: NodeJS.ProcessEnv): string
  /**
   * Lists session files under `root`. A missing root yields an empty list.
   * The hint lets an adapter skip expensive work for files outside the window.
   */
  discover(root: string, hint?: DiscoverHint): Promise<SessionFile[]>
  /** Folds one session file into a Session. */
  parse(
    file: SessionFile,
    counters: FileCounters,
    onText?: TextVisitor,
  ): Promise<ParseOutcome>
  /** Usage by model from one subagent file; merged into the parent session. */
  parseSubagent(
    path: string,
    counters: FileCounters,
    onText?: TextVisitor,
  ): Promise<Record<string, TokenTotals>>
}

export type DiscoverHint = { sinceMs?: number }

/** A source and the directory to read it from. */
export type SourceRoot = { source: AgentSource; root: string }
