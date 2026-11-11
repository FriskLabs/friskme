/** One API usage record, deduplicated by `message.id`. */
export type TokenTotals = {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

export type ToolStep = {
  tool: string
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

export type BashRun = {
  /** Whitespace-collapsed command. Local only; never sent to a model. */
  normalized: string
  messageId: string
  isError: boolean
}

export type MessageUsage = { model: string; totals: TokenTotals }

export type Session = {
  id: string
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
