import { commandFamily } from '../lib/command-family.ts'
import { parseMcpToolName } from '../lib/mcp-tool-name.ts'

const FILE_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Read',
])
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

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

export function fileExtension(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return 'noext'
  return base.slice(dot + 1).toLowerCase()
}

/** Fold key: tool plus coarse detail. */
export function stepKey(step: { tool: string; detail: string | null }): string {
  return step.detail ? `${step.tool}:${step.detail}` : step.tool
}

export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}
