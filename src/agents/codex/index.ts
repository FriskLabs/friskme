import { homedir } from 'node:os'
import { join } from 'node:path'
import { listDir, statOrNull } from '../../parse/fs.ts'
import type { AgentSource, DiscoverHint, SessionFile } from '../types.ts'
import { parseCodexSession, parseCodexSubagent } from './build-session.ts'
import { readSessionMeta } from './read-rollout.ts'

export function codexSessionsRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = env.CODEX_HOME || join(homedir(), '.codex')
  return join(base, 'sessions')
}

const ROLLOUT = /^rollout-.*\.jsonl(\.zst)?$/
const UUID =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/i

async function walk(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 6) return
  for (const e of await listDir(dir)) {
    const path = join(dir, e.name)
    if (e.isDirectory()) await walk(path, out, depth + 1)
    else if (e.isFile() && ROLLOUT.test(e.name)) out.push(path)
  }
}

type Found = {
  path: string
  mtimeMs: number
  id: string
  parentId: string | null
}

/**
 * Lists `<root>/YYYY/MM/DD/rollout-*.jsonl[.zst]`. A rollout whose
 * `session_meta.source` is `{subagent: {thread_spawn: {parent_thread_id}}}`
 * was spawned by another session; it is attached to its top-level ancestor
 * as a subagent file, never listed on its own. Read-only.
 *
 * Telling the two apart needs the header line, which for compressed rollouts
 * means decompressing the file, so files older than the hint's window are
 * listed by name alone (the loader skips them anyway).
 */
export async function discoverCodexFiles(
  root: string,
  hint: DiscoverHint = {},
): Promise<SessionFile[]> {
  const paths: string[] = []
  await walk(root, paths)
  const found: Found[] = []
  for (const path of paths.sort()) {
    const info = await statOrNull(path)
    if (!info) continue
    const nameId = path.match(UUID)?.[1] ?? path
    const inWindow = hint.sinceMs === undefined || info.mtimeMs >= hint.sinceMs
    const meta = inWindow ? await readSessionMeta(path) : null
    const parent = meta?.source?.subagent?.thread_spawn?.parent_thread_id
    found.push({
      path,
      mtimeMs: info.mtimeMs,
      id: typeof meta?.id === 'string' && meta.id ? meta.id : nameId,
      parentId: typeof parent === 'string' && parent ? parent : null,
    })
  }

  const byId = new Map(found.map((f) => [f.id, f]))
  const topOf = (f: Found): Found | null => {
    let cur = f
    for (let i = 0; i < 16 && cur.parentId; i++) {
      const next = byId.get(cur.parentId)
      if (!next) return null
      cur = next
    }
    return cur.parentId ? null : cur
  }

  const out = new Map<string, SessionFile>()
  for (const f of found) {
    if (f.parentId) continue
    out.set(f.id, {
      path: f.path,
      sessionId: f.id,
      mtimeMs: f.mtimeMs,
      subagentPaths: [],
    })
  }
  for (const f of found) {
    if (!f.parentId) continue
    // A subagent whose parent rollout is gone has no session to belong to.
    const top = topOf(f)
    const parent = top ? out.get(top.id) : undefined
    if (!parent) continue
    parent.subagentPaths.push(f.path)
    // The parent's activity runs at least until its subagents' last write.
    parent.mtimeMs = Math.max(parent.mtimeMs, f.mtimeMs)
  }
  return [...out.values()]
}

export const codexSource: AgentSource = {
  id: 'codex',
  displayName: 'Codex',
  defaultRoot: codexSessionsRoot,
  discover: discoverCodexFiles,
  parse: (file, counters, onText) =>
    parseCodexSession(file.path, counters, onText),
  parseSubagent: parseCodexSubagent,
}
