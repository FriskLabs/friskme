import { type Cache, sha256 } from '../cache.ts'
import { stepKey } from '../parse/tool-step.ts'
import type { ToolStep } from '../types.ts'
import type { ClaudeRunner } from './claude-runner.ts'
import {
  PROMPT_VERSION,
  SKILL_SCHEMA,
  type SkillDraft,
  skillPrompt,
  skillValidator,
} from './prompts.ts'

export const MIN_SKILL_SESSIONS = 4
export const SIMILARITY_THRESHOLD = 0.8
export const MAX_REPRESENTATIVES = 5

/** How often each tool (with its coarse detail) was used in a session. */
export function toolMix(steps: ToolStep[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const st of steps) m.set(stepKey(st), (m.get(stepKey(st)) ?? 0) + 1)
  return m
}

/**
 * Cosine similarity of two tool mixes: 1 when two sessions used tools in the
 * same proportions, 0 when they share none. Order-insensitive on purpose:
 * real sessions run ~40 steps, and two runs of the same workflow rarely share
 * an exact order (measured: folded-bigram Jaccard between sessions had a 90th
 * percentile of 0.17, so it could not tell same-workflow pairs apart).
 */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [k, v] of a) {
    na += v * v
    dot += v * (b.get(k) ?? 0)
  }
  for (const v of b.values()) nb += v * v
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

export type WorkflowCluster = {
  /** Session ids, medoid first, most similar next. */
  members: string[]
  meanSimilarity: number
}

/**
 * The repeated-workflow test for one intent: the medoid (the session most
 * similar to the rest) and every member whose tool mix has cosine similarity
 * ≥ 0.8 with it. Qualifies only if that is at least 4 sessions.
 */
export function findWorkflow(
  sessions: { id: string; steps: ToolStep[] }[],
): WorkflowCluster | null {
  if (sessions.length < MIN_SKILL_SESSIONS) return null
  const mixes = sessions.map((s) => toolMix(s.steps))
  let medoid = 0
  let bestTotal = -1
  for (let i = 0; i < mixes.length; i++) {
    let total = 0
    for (let j = 0; j < mixes.length; j++)
      if (i !== j) total += cosine(mixes[i]!, mixes[j]!)
    if (total > bestTotal) {
      bestTotal = total
      medoid = i
    }
  }
  const scored = sessions
    .map((s, i) => ({
      id: s.id,
      sim: i === medoid ? 1 : cosine(mixes[medoid]!, mixes[i]!),
      isMedoid: i === medoid,
    }))
    .filter((x) => x.isMedoid || x.sim >= SIMILARITY_THRESHOLD)
    .sort((a, b) => Number(b.isMedoid) - Number(a.isMedoid) || b.sim - a.sim)
  if (scored.length < MIN_SKILL_SESSIONS) return null
  const others = scored.filter((x) => !x.isMedoid)
  return {
    members: scored.map((x) => x.id),
    meanSimilarity:
      others.reduce((n, x) => n + x.sim, 0) / Math.max(1, others.length),
  }
}

export async function draftSkill(opts: {
  intent: { name: string; description: string }
  cards: string[]
  runner: ClaudeRunner
  cache: Cache
  model: string
}): Promise<{ draft: SkillDraft | null; cached: boolean; reason?: string }> {
  const cards = opts.cards.slice(0, MAX_REPRESENTATIVES)
  const key = sha256(
    `${PROMPT_VERSION}\n${opts.model}\n${opts.intent.name}\n${cards.join('\n---\n')}`,
  )
  const hit = opts.cache.get<SkillDraft>('skills', key)
  if (hit) return { draft: hit, cached: true }
  const out = await opts.runner.run(
    skillPrompt(opts.intent, cards),
    SKILL_SCHEMA,
    skillValidator,
  )
  if (!out.ok) return { draft: null, cached: false, reason: out.reason }
  opts.cache.set('skills', key, out.value)
  return { draft: out.value, cached: false }
}
