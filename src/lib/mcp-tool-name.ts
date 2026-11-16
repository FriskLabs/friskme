const MCP_PREFIX = 'mcp__'
const SEPARATOR = '__'

export type McpToolName = { server: string; tool: string | null }

/**
 * Parses Claude Code's MCP tool naming, `mcp__<server>__<tool>`, as documented
 * for permission rules (https://code.claude.com/docs/en/permissions, "MCP"):
 * `mcp__puppeteer__puppeteer_navigate` is the `puppeteer_navigate` tool of the
 * `puppeteer` server, and a bare `mcp__puppeteer` names the server alone.
 *
 * The server is the text up to the first `__` after the prefix, and the tool is
 * everything after it. A server whose own name contains `__` is therefore read
 * as its first segment, which is the same reading Claude Code gives the bare
 * `mcp__reports__v2` form; the full name is not recoverable from the tool name.
 * Claude Code also rewrites `.` and spaces in server names to `_`, so the server
 * here is that rewritten form, not necessarily the configured name.
 *
 * Returns `null` for anything that is not an MCP tool name.
 */
export function parseMcpToolName(name: string): McpToolName | null {
  if (!name.startsWith(MCP_PREFIX)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const separator = rest.indexOf(SEPARATOR)
  const server = separator === -1 ? rest : rest.slice(0, separator)
  if (server.length === 0) return null
  const tool = separator === -1 ? '' : rest.slice(separator + SEPARATOR.length)
  return { server, tool: tool.length > 0 ? tool : null }
}

/** The MCP server a Claude Code tool name belongs to, or `null`. */
export function mcpServerFromToolName(name: string): string | null {
  return parseMcpToolName(name)?.server ?? null
}
