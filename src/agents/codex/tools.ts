import { commandFamily } from '../../lib/command-family.ts'
import { parseMcpToolName } from '../../lib/mcp-tool-name.ts'
import { fileExtension } from '../../parse/tool-step.ts'
import type { ToolKind } from '../../types.ts'

const SHELL_TOOLS = new Set([
  'exec_command',
  'shell',
  'shell_command',
  'local_shell',
  'exec',
  'write_stdin',
  'unified_exec',
])
const SUBAGENT_TOOLS = new Set([
  'spawn_agent',
  'wait',
  'close_agent',
  'send_input',
])

/** Maps a Codex tool name onto frisk's agent-neutral tool kinds. */
export function codexToolKind(name: string): ToolKind {
  if (SHELL_TOOLS.has(name)) return 'shell'
  if (name === 'apply_patch') return 'edit'
  if (name === 'view_image' || name === 'read_file' || name === 'list_dir')
    return 'read'
  if (SUBAGENT_TOOLS.has(name)) return 'subagent'
  if (name === 'update_plan') return 'plan'
  if (name === 'mcp' || parseMcpToolName(name)) return 'mcp'
  return 'other'
}

/**
 * The command a shell tool ran, as one string. `shell` takes an argv array,
 * usually `["bash", "-lc", "<cmd>"]`; the others take a string.
 */
export function shellCommand(name: string, args: any): string | null {
  if (name === 'write_stdin') return null
  const raw = args?.cmd ?? args?.command
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && raw.every((x) => typeof x === 'string')) {
    const [shell, flag, script] = raw as string[]
    if (
      raw.length === 3 &&
      /(^|\/)(ba|z|da)?sh$/.test(shell ?? '') &&
      /^-\w*c$/.test(flag ?? '')
    )
      return script ?? ''
    return raw.join(' ')
  }
  return null
}

/** The first file an `apply_patch` touches, from its `*** Update File:` header. */
export function patchFirstPath(patch: string): string | null {
  const m = patch.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m)
  return m ? m[1]!.trim() : null
}

/**
 * The coarse detail a tool step is folded and shown by, mirroring the Claude
 * adapter: a command's family, a file's extension, a subagent's type, an MCP
 * server. The raw input never leaves this function.
 */
export function codexToolDetail(name: string, args: any): string | null {
  if (name === 'write_stdin') return 'stdin'
  if (SHELL_TOOLS.has(name)) {
    const cmd = shellCommand(name, args)
    return cmd === null ? null : commandFamily(cmd)
  }
  if (name === 'apply_patch') {
    const patch = typeof args === 'string' ? args : args?.input
    const path = typeof patch === 'string' ? patchFirstPath(patch) : null
    return path ? fileExtension(path) : null
  }
  if (name === 'spawn_agent') {
    const type = args?.agent_type
    return typeof type === 'string' && type.length > 0 ? type : 'general'
  }
  if (name === 'view_image') {
    const path = args?.path
    return typeof path === 'string' ? fileExtension(path) : null
  }
  const mcp = parseMcpToolName(name)
  if (mcp) return mcp.server
  return null
}

export function codexToolDisplayName(name: string): string {
  return parseMcpToolName(name) ? 'mcp' : name
}

/**
 * Whether a tool output reports failure. Codex encodes the exit code either as
 * JSON (`{"output", "metadata": {"exit_code"}}`) or as a text header
 * (`Process exited with code N`, `Exit code: N`).
 */
export function outputIsError(output: unknown): boolean {
  if (typeof output !== 'string') return false
  const head = output.slice(0, 4096)
  if (head.startsWith('{')) {
    try {
      const j = JSON.parse(output)
      const code = j?.metadata?.exit_code
      if (typeof code === 'number') return code !== 0
      return j?.success === false
    } catch {
      // Not JSON after all; fall through to the text checks.
    }
  }
  const m = head.match(/(?:Process exited with code|Exit code:)\s*(-?\d+)/)
  if (m) return Number(m[1]) !== 0
  return /^(apply_patch verification failed|error:|failed to )/i.test(head)
}

/** Text of a tool output for the sensitive scan: the JSON `output` field or the raw string. */
export function outputText(output: unknown): string {
  if (typeof output !== 'string') {
    if (Array.isArray(output))
      return output
        .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
        .filter(Boolean)
        .join('\n')
    return ''
  }
  if (output.startsWith('{')) {
    try {
      const j = JSON.parse(output)
      if (typeof j?.output === 'string') return j.output
    } catch {
      // Plain text that starts with a brace.
    }
  }
  return output
}
