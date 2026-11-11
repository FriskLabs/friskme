import type { SourceRoot } from './agents/types.ts'
import {
  emptyCounters,
  mergeSubagentUsage,
  type TextVisitor,
} from './parse/common.ts'
import type { ParseStats, Session } from './types.ts'

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
  /** Called once a source's files are found (done = 0), then after each file. */
  onProgress?: (agent: string, done: number, total: number) => void
}

export type LoadResult = {
  sessions: Session[]
  stats: ParseStats
  filteredByProject: number
}

/** Reads every source, applies the window and filters, and merges the result. */
export async function loadSessions(
  sources: SourceRoot[],
  opts: LoadOptions,
): Promise<LoadResult> {
  const counters = emptyCounters()
  const stats: ParseStats = {
    files: 0,
    subagentFiles: 0,
    sessions: 0,
    skippedNoPrompt: 0,
    skippedFriskSelf: 0,
    skippedOutsideWindow: 0,
    malformedLines: 0,
    ignoredLineTypes: counters.ignoredLineTypes,
    unknownLineTypes: counters.unknownLineTypes,
    byAgent: {},
  }
  let sessions: Session[] = []
  let filteredByProject = 0
  for (const { source, root } of sources) {
    const files = await source.discover(root, { sinceMs: opts.sinceMs })
    const agentStats = { files: files.length, sessions: 0 }
    stats.byAgent[source.id] = agentStats
    stats.files += files.length
    const progress = (done: number) =>
      opts.onProgress?.(source.displayName, done, files.length)
    const readOne = async (
      f: (typeof files)[number],
    ): Promise<Session | null> => {
      const onText = opts.textVisitor?.(f.sessionId)
      const outcome = await source.parse(f, counters, onText)
      if (outcome.status === 'no-prompt') {
        stats.skippedNoPrompt++
        return null
      }
      if (outcome.status === 'frisk-self') {
        stats.skippedFriskSelf++
        return null
      }
      const s = outcome.session
      if (Date.parse(s.end) < opts.sinceMs) {
        stats.skippedOutsideWindow++
        return null
      }
      if (
        opts.project &&
        !s.project.toLowerCase().includes(opts.project.toLowerCase())
      ) {
        filteredByProject++
        return null
      }
      for (const sub of f.subagentPaths) {
        stats.subagentFiles++
        mergeSubagentUsage(s, await source.parseSubagent(sub, counters, onText))
      }
      return s
    }
    progress(0)
    for (const [i, f] of files.entries()) {
      // A file last written before the window cannot hold a session inside it.
      if (f.mtimeMs < opts.sinceMs) {
        stats.skippedOutsideWindow++
      } else {
        const s = await readOne(f)
        if (s) sessions.push(s)
      }
      progress(i + 1)
    }
  }
  sessions.sort((a, b) => (a.start < b.start ? 1 : -1))
  if (opts.maxSessions !== undefined && sessions.length > opts.maxSessions) {
    sessions = sessions.slice(0, opts.maxSessions)
  }
  for (const s of sessions) {
    const a = stats.byAgent[s.agent]
    if (a) a.sessions++
  }
  stats.malformedLines = counters.malformedLines
  stats.sessions = sessions.length
  return { sessions, stats, filteredByProject }
}
