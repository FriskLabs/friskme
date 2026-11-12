import { homedir } from 'node:os'
import { join } from 'node:path'
import { listDir, statOrNull } from '../../parse/fs.ts'
import type { AgentSource, SessionFile } from '../types.ts'
import { parsePiSession } from './build-session.ts'

/**
 * pi's session folder: `$PI_CODING_AGENT_SESSION_DIR`, else
 * `$PI_CODING_AGENT_DIR/sessions`, else `~/.pi/agent/sessions`. pi's own
 * `sessionDir` setting is not read; the env vars cover the override.
 */
export function piSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR
  const base = env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
  return join(base, 'sessions')
}

const SESSION_FILE = /\.jsonl$/
const UUID =
  /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * Lists `<root>/--<cwd>--/<timestamp>_<id>.jsonl`. pi writes no subagent
 * files, so every file is its own session. Read-only.
 */
export async function discoverPiFiles(root: string): Promise<SessionFile[]> {
  const out: SessionFile[] = []
  for (const dir of await listDir(root)) {
    if (!dir.isDirectory()) continue
    const dirPath = join(root, dir.name)
    for (const e of await listDir(dirPath)) {
      if (!e.isFile() || !SESSION_FILE.test(e.name)) continue
      const path = join(dirPath, e.name)
      const info = await statOrNull(path)
      if (!info) continue
      out.push({
        path,
        sessionId: e.name.match(UUID)?.[1] ?? e.name.replace(SESSION_FILE, ''),
        mtimeMs: info.mtimeMs,
        subagentPaths: [],
      })
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export const piSource: AgentSource = {
  id: 'pi',
  displayName: 'Pi',
  defaultRoot: piSessionsRoot,
  discover: discoverPiFiles,
  parse: (file, counters, onText) =>
    parsePiSession(file.path, counters, onText),
  parseSubagent: async () => ({}),
}
