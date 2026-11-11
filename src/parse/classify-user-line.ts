import type { PromptSource } from '../types.ts'

/**
 * What a `type: "user"` transcript line is. Only `human` and `command` lines
 * carry something a person typed; everything else is tool output, harness
 * injection, or bookkeeping.
 */
export type UserLineKind =
  | { kind: 'human'; text: string; source: PromptSource }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'tool_result'; results: { toolUseId: string; isError: boolean }[] }
  | { kind: 'interrupt'; forToolUse: boolean }
  | { kind: 'compact_summary' }
  | { kind: 'meta' }

/** Wrapper prefixes that mark text the harness wrote, not the person. */
const HARNESS_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<system-reminder>',
  '<task-notification>',
  '<user-prompt-submit-hook>',
  '[Request interrupted',
  '[Image:',
  '[SYSTEM NOTIFICATION',
  'Caveat: The messages below were generated',
]

/**
 * Built-in commands that change the session but say nothing about the task.
 * A command not on this list, invoked with arguments, is treated as intent
 * (`/review 123`, `/my-skill fix the flaky test`).
 */
const BUILTIN_COMMANDS = new Set([
  'add-dir',
  'agents',
  'artifacts',
  'bug',
  'clear',
  'compact',
  'config',
  'context',
  'cost',
  'doctor',
  'exit',
  'export',
  'fast',
  'feedback',
  'help',
  'hooks',
  'ide',
  'init',
  'login',
  'logout',
  'mcp',
  'memory',
  'model',
  'permissions',
  'plugin',
  'plugins',
  'quit',
  'release-notes',
  'remote-control',
  'resume',
  'rewind',
  'skills',
  'status',
  'statusline',
  'terminal-setup',
  'theme',
  'todos',
  'usage',
  'vim',
])

type Block = {
  type?: string
  text?: string
  tool_use_id?: string
  is_error?: unknown
}

export function classifyUserLine(line: any): UserLineKind {
  const content = line?.message?.content
  const blocks: Block[] = Array.isArray(content) ? content : []

  const results = blocks.filter((b) => b?.type === 'tool_result')
  if (results.length > 0) {
    return {
      kind: 'tool_result',
      results: results.map((b) => ({
        toolUseId: String(b.tool_use_id ?? ''),
        isError: b.is_error === true,
      })),
    }
  }

  const text =
    typeof content === 'string'
      ? content
      : blocks
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
  const trimmed = text.trimStart()

  if (trimmed.startsWith('[Request interrupted by user')) {
    return { kind: 'interrupt', forToolUse: trimmed.includes('for tool use') }
  }
  if (line.isCompactSummary === true) return { kind: 'compact_summary' }

  const command = parseCommand(trimmed)
  if (command) return command

  if (
    line.isMeta === true ||
    line.isVisibleInTranscriptOnly === true ||
    line.isSidechain === true
  ) {
    return { kind: 'meta' }
  }

  // Newer Claude Code marks who started a turn explicitly.
  const originKind = line.origin?.kind
  if (typeof originKind === 'string') {
    if (originKind !== 'human' || trimmed.length === 0) return { kind: 'meta' }
    return {
      kind: 'human',
      text: trimmed,
      source: promptSource(line.promptSource),
    }
  }

  // Older versions: no `origin`, so fall back to excluding known wrappers.
  if (trimmed.length === 0) return { kind: 'meta' }
  if (HARNESS_PREFIXES.some((p) => trimmed.startsWith(p)))
    return { kind: 'meta' }
  return { kind: 'human', text: trimmed, source: 'legacy' }
}

function promptSource(value: unknown): PromptSource {
  if (value === 'queued') return 'queued'
  if (value === 'suggestion_accepted') return 'suggestion'
  return 'typed'
}

const COMMAND_NAME = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

function parseCommand(text: string): UserLineKind | null {
  if (!text.startsWith('<command-')) return null
  const name = COMMAND_NAME.exec(text)?.[1]
  if (!name) return null
  const args = (COMMAND_ARGS.exec(text)?.[1] ?? '').trim()
  return { kind: 'command', name, args }
}

/** Whether a slash command carries task intent worth labeling. */
export function commandIsIntent(name: string, args: string): boolean {
  return args.length > 0 && !BUILTIN_COMMANDS.has(name.toLowerCase())
}
