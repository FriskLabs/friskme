import { FRISK_SENTINEL } from '../constants.ts'
import type { SegmentSource } from '../sensitive/types.ts'
import {
  type AgentId,
  addTotals,
  emptyTotals,
  type Session,
  type TokenTotals,
} from '../types.ts'
import { resolveProject } from './project.ts'

/** One block of transcript text, for the sensitive-data scan. */
export type TextVisit = {
  source: SegmentSource
  tool: string | null
  ts: string
  text: string
}
export type TextVisitor = (segment: TextVisit) => void

/** Text blocks larger than this are cut before scanning (whole-file writes, huge logs). */
const MAX_SEGMENT_CHARS = 512 * 1024

export function clip(text: string): string {
  return text.length > MAX_SEGMENT_CHARS
    ? text.slice(0, MAX_SEGMENT_CHARS)
    : text
}

export type FileCounters = {
  malformedLines: number
  ignoredLineTypes: Record<string, number>
  unknownLineTypes: Record<string, number>
}

export function emptyCounters(): FileCounters {
  return { malformedLines: 0, ignoredLineTypes: {}, unknownLineTypes: {} }
}

/** Counts a line type frisk skipped, as known-and-ignored or unknown. */
export function countLineType(
  counters: FileCounters,
  type: unknown,
  ignored: ReadonlySet<string>,
): void {
  const key = typeof type === 'string' ? type : '(missing)'
  const bucket = ignored.has(key)
    ? counters.ignoredLineTypes
    : counters.unknownLineTypes
  bucket[key] = (bucket[key] ?? 0) + 1
}

export type ParseOutcome =
  | { status: 'ok'; session: Session }
  | { status: 'no-prompt' }
  | { status: 'frisk-self' }

export function emptySession(id: string, agent: AgentId): Session {
  return {
    id,
    agent,
    project: '',
    projectLabel: '',
    branch: null,
    entrypoint: null,
    sessionKind: null,
    start: '',
    end: '',
    models: [],
    prompts: [],
    slashCommands: [],
    steps: [],
    bashRuns: [],
    errors: 0,
    interrupts: 0,
    denials: 0,
    compactions: 0,
    endedAfterInterrupt: false,
    interruptedTurnMessageIds: [],
    tokens: {},
    subagents: { count: 0, tokens: {} },
    messageUsage: {},
  }
}

/**
 * The checks every adapter applies once a file is folded: a session needs a
 * typed prompt, and one that frisk itself started is dropped.
 */
export function finishSession(s: Session): ParseOutcome {
  if (s.prompts.length === 0) return { status: 'no-prompt' }
  if (s.prompts[0]!.text.startsWith(FRISK_SENTINEL))
    return { status: 'frisk-self' }
  if (!s.project) {
    s.project = '(unknown)'
    s.projectLabel = '(unknown)'
  } else {
    // Adapters set project to the cwd; count worktrees under their repo.
    const { root, label } = resolveProject(s.project)
    s.project = root
    s.projectLabel = label
  }
  return { status: 'ok', session: s }
}

/** Every string value in a tool input, for the sensitive-data scan. */
export function stringValues(input: unknown): string {
  const parts: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (depth > 4) return
    if (typeof v === 'string') parts.push(v)
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1)
    else if (v && typeof v === 'object')
      for (const x of Object.values(v)) walk(x, depth + 1)
  }
  walk(input, 0)
  return parts.join('\n')
}

export function mergeSubagentUsage(
  s: Session,
  byModel: Record<string, TokenTotals>,
): void {
  s.subagents.count++
  for (const [model, totals] of Object.entries(byModel)) {
    s.subagents.tokens[model] ??= emptyTotals()
    addTotals(s.subagents.tokens[model], totals)
    s.tokens[model] ??= emptyTotals()
    addTotals(s.tokens[model], totals)
    if (!s.models.includes(model)) s.models = [...s.models, model].sort()
  }
}
