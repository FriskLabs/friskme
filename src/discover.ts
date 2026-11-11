import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  emptyCounters,
  mergeSubagentUsage,
  parseSessionFile,
  parseSubagentFile,
  type TextVisitor,
} from './parse/build-session.ts'
import type { ParseStats, Session } from './types.ts'

export function projectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'projects')
}

export type SessionFile = {
  path: string
  mtimeMs: number
  subagentPaths: string[]
}

async function listDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Lists `<root>/<encoded-cwd>/<session>.jsonl` and each session's
 * `<session>/subagents/*.jsonl`. Read-only: only readdir and stat.
 */
export async function discoverSessionFiles(
  root: string,
): Promise<SessionFile[]> {
  const out: SessionFile[] = []
  for (const project of await listDir(root)) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const entry of await listDir(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const path = join(projectDir, entry.name)
      const sessionDir = join(projectDir, entry.name.replace(/\.jsonl$/, ''))
      const subagentPaths = (await listDir(join(sessionDir, 'subagents')))
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => join(sessionDir, 'subagents', e.name))
      const info = await stat(path).catch(() => null)
      if (!info) continue
      out.push({ path, mtimeMs: info.mtimeMs, subagentPaths })
    }
  }
  return out
}

export type LoadOptions = {
  sinceMs: number
  project?: string
  maxSessions?: number
  /**
   * Called with each session's text as it streams by, for the sensitive-data
   * scan. Findings for sessions dropped later (window, --project, frisk's own)
   * are discarded by the caller.
   */
  textVisitor?: (sessionId: string) => TextVisitor
}

export type LoadResult = {
  sessions: Session[]
  stats: ParseStats
  filteredByProject: number
}

export async function loadSessions(
  root: string,
  opts: LoadOptions,
): Promise<LoadResult> {
  const files = await discoverSessionFiles(root)
  const counters = emptyCounters()
  const stats: ParseStats = {
    files: files.length,
    subagentFiles: 0,
    sessions: 0,
    skippedNoPrompt: 0,
    skippedFriskSelf: 0,
    skippedOutsideWindow: 0,
    malformedLines: 0,
    ignoredLineTypes: counters.ignoredLineTypes,
    unknownLineTypes: counters.unknownLineTypes,
  }
  let sessions: Session[] = []
  let filteredByProject = 0
  for (const f of files) {
    // A file last written before the window cannot hold a session inside it.
    if (f.mtimeMs < opts.sinceMs) {
      stats.skippedOutsideWindow++
      continue
    }
    const sessionId = basename(f.path).replace(/\.jsonl$/, '')
    const onText = opts.textVisitor?.(sessionId)
    const outcome = await parseSessionFile(f.path, counters, onText)
    if (outcome.status === 'no-prompt') {
      stats.skippedNoPrompt++
      continue
    }
    if (outcome.status === 'frisk-self') {
      stats.skippedFriskSelf++
      continue
    }
    const s = outcome.session
    if (Date.parse(s.end) < opts.sinceMs) {
      stats.skippedOutsideWindow++
      continue
    }
    if (
      opts.project &&
      !s.project.toLowerCase().includes(opts.project.toLowerCase())
    ) {
      filteredByProject++
      continue
    }
    for (const sub of f.subagentPaths) {
      stats.subagentFiles++
      mergeSubagentUsage(s, await parseSubagentFile(sub, counters, onText))
    }
    sessions.push(s)
  }
  sessions.sort((a, b) => (a.start < b.start ? 1 : -1))
  if (opts.maxSessions !== undefined && sessions.length > opts.maxSessions) {
    sessions = sessions.slice(0, opts.maxSessions)
  }
  stats.malformedLines = counters.malformedLines
  stats.sessions = sessions.length
  return { sessions, stats, filteredByProject }
}
