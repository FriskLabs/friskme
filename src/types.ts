/** The coding agents frisk reads. Each one has an adapter in `src/agents/`. */
export const AGENT_IDS = ['claude', 'codex'] as const
export type AgentId = (typeof AGENT_IDS)[number]

/**
 * What a tool step did, in an agent-neutral vocabulary. Adapters map their own
 * tool names onto it so detectors never match on a specific agent's names.
 */
export type ToolKind =
  | 'shell'
  | 'edit'
  | 'read'
  | 'subagent'
  | 'mcp'
  | 'plan'
  | 'other'

/** One API usage record, deduplicated by `message.id`. */
export type TokenTotals = {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

export type ToolStep = {
  /** The agent's own tool name (`Bash`, `exec_command`); MCP tools are `mcp`. */
  tool: string
  kind: ToolKind
  /** Coarse detail: Bash command family, file extension, MCP server, subagent type. */
  detail: string | null
  isError: boolean
  /** The assistant `message.id` that emitted the tool_use. */
  messageId: string
  toolUseId: string
  ts: string
}

export type PromptSource =
  | 'typed'
  | 'queued'
  | 'suggestion'
  | 'legacy'
  | 'command'

export type Prompt = { text: string; ts: string; source: PromptSource }

/** One shell command the agent ran (Bash, exec_command, …). */
export type BashRun = {
  /** Whitespace-collapsed command. Local only; never sent to a model. */
  normalized: string
  messageId: string
  isError: boolean
}

export type MessageUsage = { model: string; totals: TokenTotals }

export type Session = {
  id: string
  agent: AgentId
  /** The `cwd` on the first line that has one. Never decoded from the dir name. */
  project: string
  projectLabel: string
  branch: string | null
  entrypoint: string | null
  sessionKind: string | null
  start: string
  end: string
  models: string[]
  prompts: Prompt[]
  slashCommands: string[]
  steps: ToolStep[]
  bashRuns: BashRun[]
  errors: number
  interrupts: number
  denials: number
  compactions: number
  endedAfterInterrupt: boolean
  /** Message ids of the assistant turn that was interrupted last, if any. */
  interruptedTurnMessageIds: string[]
  /** Main thread plus subagents, by model. */
  tokens: Record<string, TokenTotals>
  subagents: { count: number; tokens: Record<string, TokenTotals> }
  /** Main-thread usage per assistant message, for pricing waste spans. */
  messageUsage: Record<string, MessageUsage>
}

export type ParseStats = {
  files: number
  subagentFiles: number
  sessions: number
  skippedNoPrompt: number
  skippedFriskSelf: number
  skippedOutsideWindow: number
  malformedLines: number
  ignoredLineTypes: Record<string, number>
  unknownLineTypes: Record<string, number>
  /** Files found and sessions kept, per agent that was scanned. */
  byAgent: Partial<Record<AgentId, { files: number; sessions: number }>>
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }
}

export function addTotals(into: TokenTotals, add: TokenTotals): void {
  into.input += add.input
  into.output += add.output
  into.cacheWrite5m += add.cacheWrite5m
  into.cacheWrite1h += add.cacheWrite1h
  into.cacheRead += add.cacheRead
}

export function sumTokens(t: TokenTotals): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead
}
