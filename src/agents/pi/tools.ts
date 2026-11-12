import { commandFamily } from '../../lib/command-family.ts'
import { parseMcpToolName } from '../../lib/mcp-tool-name.ts'
import { fileExtension } from '../../parse/tool-step.ts'
import type { ToolKind } from '../../types.ts'

const SHELL_TOOLS = new Set(['bash', 'powershell'])
const EDIT_TOOLS = new Set(['edit', 'write'])
const SEARCH_TOOLS = new Set(['grep', 'find', 'ls'])

/** Maps a pi tool name onto frisk's agent-neutral tool kinds. */
export function piToolKind(name: string): ToolKind {
  if (SHELL_TOOLS.has(name)) return 'shell'
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (name === 'read' || SEARCH_TOOLS.has(name)) return 'read'
  // pi has no built-in subagents; the extension example registers `subagent`.
  if (name === 'subagent') return 'subagent'
  if (parseMcpToolName(name)) return 'mcp'
  return 'other'
}

/** The command a shell tool ran, or null when its input has none. */
export function piShellCommand(args: any): string | null {
  const cmd = args?.command
  return typeof cmd === 'string' ? cmd : null
}

/**
 * The coarse detail a tool step is folded and shown by, mirroring the other
 * adapters: a command's family, a file's extension, a subagent's name, an MCP
 * server. The raw input never leaves this function.
 */
export function piToolDetail(name: string, args: any): string | null {
  if (SHELL_TOOLS.has(name)) {
    const cmd = piShellCommand(args)
    return cmd === null ? null : commandFamily(cmd)
  }
  if (EDIT_TOOLS.has(name) || name === 'read') {
    const path = args?.path
    return typeof path === 'string' && path ? fileExtension(path) : null
  }
  if (name === 'subagent') {
    const agent = args?.agent
    return typeof agent === 'string' && agent ? agent : 'general'
  }
  const mcp = parseMcpToolName(name)
  if (mcp) return mcp.server
  return null
}

export function piToolDisplayName(name: string): string {
  return parseMcpToolName(name) ? 'mcp' : name
}
