import { homedir } from 'node:os'
import { join } from 'node:path'
import { listDir, statOrNull } from '../../parse/fs.ts'
import type { AgentSource, SessionFile } from '../types.ts'
import { parseSessionFile, parseSubagentFile } from './build-session.ts'

export function claudeProjectsRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'projects')
}

/**
 * Lists `<root>/<encoded-cwd>/<session>.jsonl` and each session's
 * `<session>/subagents/*.jsonl`. Read-only: only readdir and stat.
 */
export async function discoverClaudeFiles(
  root: string,
): Promise<SessionFile[]> {
  const out: SessionFile[] = []
  for (const project of await listDir(root)) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const entry of await listDir(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const path = join(projectDir, entry.name)
      const sessionId = entry.name.replace(/\.jsonl$/, '')
      const sessionDir = join(projectDir, sessionId)
      const subagentPaths = (await listDir(join(sessionDir, 'subagents')))
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => join(sessionDir, 'subagents', e.name))
      const info = await statOrNull(path)
      if (!info) continue
      out.push({ path, sessionId, mtimeMs: info.mtimeMs, subagentPaths })
    }
  }
  return out
}

export const claudeSource: AgentSource = {
  id: 'claude',
  displayName: 'Claude Code',
  defaultRoot: claudeProjectsRoot,
  discover: discoverClaudeFiles,
  parse: (file, counters, onText) =>
    parseSessionFile(file.path, counters, onText),
  parseSubagent: parseSubagentFile,
}
