import { commandFamily } from '../../lib/command-family.ts'
import { parseMcpToolName } from '../../lib/mcp-tool-name.ts'
import { fileExtension } from '../../parse/tool-step.ts'
import type { ToolKind } from '../../types.ts'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
const FILE_TOOLS = new Set([...EDIT_TOOLS, 'Read'])
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
const PLAN_TOOLS = new Set(['TodoWrite', 'ExitPlanMode', 'EnterPlanMode'])

/** Maps a Claude Code tool name onto frisk's agent-neutral tool kinds. */
export function claudeToolKind(name: string): ToolKind {
  if (name === 'Bash') return 'shell'
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (READ_TOOLS.has(name)) return 'read'
  if (SUBAGENT_TOOLS.has(name)) return 'subagent'
  if (PLAN_TOOLS.has(name)) return 'plan'
  if (name === 'mcp' || parseMcpToolName(name)) return 'mcp'
  return 'other'
}

/**
 * The coarse detail a tool step is folded and shown by. Deliberately lossy:
 * a Bash command becomes its family, a file path its extension, an MCP call
 * its server. The raw input never leaves this function.
 */
export function toolDetail(name: string, input: any): string | null {
  if (name === 'Bash') {
    const command = typeof input?.command === 'string' ? input.command : ''
    return commandFamily(command)
  }
  if (FILE_TOOLS.has(name)) {
    const path = input?.file_path ?? input?.notebook_path
    return typeof path === 'string' ? fileExtension(path) : null
  }
  if (SUBAGENT_TOOLS.has(name)) {
    const type = input?.subagent_type
    return typeof type === 'string' && type.length > 0 ? type : 'general'
  }
  const mcp = parseMcpToolName(name)
  if (mcp) return mcp.server
  return null
}

/** The display name: MCP tools collapse to `mcp`, so the detail carries the server. */
export function toolDisplayName(name: string): string {
  return parseMcpToolName(name) ? 'mcp' : name
}
