import { cleanPrompt, foldSequence, truncate } from '../card/build-card.ts'
import { type ScrubCounts, scrubSecrets } from '../card/scrub-secrets.ts'
import type { SessionLabel } from '../llm/label-pass.ts'
import type { GroupedIntent, SkillDraft } from '../llm/prompts.ts'
import { stepKey } from '../parse/tool-step.ts'
import type { SensitiveReport } from '../sensitive/summary.ts'
import {
  addTotals,
  emptyTotals,
  type ParseStats,
  type Session,
  sumTokens,
  type TokenTotals,
} from '../types.ts'
import {
  detectWaste,
  type WasteItem,
  type WasteKind,
  type WasteTotals,
  wasteTotals,
} from '../waste/detectors.ts'
import { PRICE_BASIS, priceTokens, RATES_AS_OF } from '../waste/rate-table.ts'
import { slugify } from './format.ts'

export const REPORT_SCHEMA_VERSION = 2

export type Count = { name: string; count: number }

export type WorkflowReport = {
  intent: string
  slug: string
  sessions: number
  meanSimilarity: number
  typicalSequence: string
  /** Relative to the output dir; null when no draft was written. */
  skillPath: string | null
  skill: SkillDraft | null
  note: string | null
  structural: boolean
}

export type IntentReport = {
  name: string
  slug: string
  description: string
  sessions: number
  share: number
  weekly: { weekStart: string; count: number }[]
  topTools: Count[]
  examples: string[]
  projects: Count[]
  categories: Count[]
  labels: Count[]
  tokens: number
  cost: number
  workflow: WorkflowReport | null
}

export type Report = {
  schemaVersion: number
  generatedAt: string
  friskVersion: string
  window: { since: string; from: string; to: string; days: number }
  source: ParseStats & { root: string; filteredByProject: number }
  llm: {
    enabled: boolean
    model: string | null
    calls: number
    failedCalls: number
    labelsFromCache: number
    unlabeledSessions: number
    groupingFellBack: boolean
    labelsLeftUngrouped: number
    skillDraftsFailed: number
    costUsd: number
    redactions: ScrubCounts
  }
  overview: {
    sessions: number
    prompts: number
    toolCalls: number
    toolErrors: number
    interrupts: number
    projects: Count[]
    models: { model: string; tokens: number; cost: number | null }[]
    entrypoints: Count[]
    sessionKinds: Count[]
    categories: Count[]
    tokens: number
    cost: number
    unpricedModels: string[]
  }
  intents: IntentReport[]
  workflows: WorkflowReport[]
  waste: {
    totals: WasteTotals
    byKind: Record<WasteKind, { items: number; tokens: number; cost: number }>
    top: WasteItem[]
  }
  rates: { asOf: string; basis: string }
  sensitive: SensitiveReport
}

function countBy<T>(
  items: T[],
  key: (t: T) => string | null | undefined,
  limit?: number,
): Count[] {
  const m = new Map<string, number>()
  for (const it of items) {
    const k = key(it)
    if (k) m.set(k, (m.get(k) ?? 0) + 1)
  }
  const out = [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return limit ? out.slice(0, limit) : out
}

function mondayOf(iso: string): string {
  const d = new Date(iso)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}

export function weekStarts(fromIso: string, toIso: string): string[] {
  const out: string[] = []
  const end = mondayOf(toIso)
  let cur = mondayOf(fromIso)
  while (cur <= end) {
    out.push(cur)
    const d = new Date(`${cur}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 7)
    cur = d.toISOString().slice(0, 10)
  }
  return out
}

export function sessionCost(s: Session): number {
  let n = 0
  for (const [model, t] of Object.entries(s.tokens))
    n += priceTokens(model, t) ?? 0
  return n
}

function examplePrompts(sessions: Session[], counts: ScrubCounts): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of sessions) {
    const text = truncate(
      scrubSecrets(cleanPrompt(s.prompts[0]?.text ?? ''), counts),
      220,
    )
    const key = text.toLowerCase().slice(0, 60)
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length === 3) break
  }
  return out
}

export type AggregateInput = {
  sessions: Session[]
  stats: ParseStats
  root: string
  filteredByProject: number
  since: string
  generatedAt: string
  friskVersion: string
  /** Absent in --no-llm mode. */
  labels?: Map<string, SessionLabel>
  intents?: GroupedIntent[]
  workflows: WorkflowReport[]
  llm: Report['llm']
  sensitive: SensitiveReport
}

/** Every count, share and total in the report is computed here, in code. */
export function aggregate(input: AggregateInput): Report {
  const { sessions } = input
  const from = sessions.reduce((m, s) => (!m || s.start < m ? s.start : m), '')
  const to = sessions.reduce((m, s) => (s.end > m ? s.end : m), '')
  const weeks = from ? weekStarts(from, to) : []

  const byModel = new Map<string, TokenTotals>()
  for (const s of sessions) {
    for (const [model, t] of Object.entries(s.tokens)) {
      const acc = byModel.get(model) ?? emptyTotals()
      addTotals(acc, t)
      byModel.set(model, acc)
    }
  }
  const models = [...byModel.entries()]
    .map(([model, t]) => ({
      model,
      tokens: sumTokens(t),
      cost: priceTokens(model, t),
    }))
    .sort((a, b) => b.tokens - a.tokens)

  const total = sessions.length
  const intents: IntentReport[] = []
  if (input.labels && input.intents) {
    const labelToIntent = new Map<string, GroupedIntent>()
    for (const it of input.intents)
      for (const l of it.labels) labelToIntent.set(l.toLowerCase(), it)
    const members = new Map<GroupedIntent, Session[]>()
    for (const s of sessions) {
      const label = input.labels.get(s.id)
      if (!label) continue
      const intent = labelToIntent.get(label.intent.toLowerCase())
      if (!intent) continue
      const list = members.get(intent) ?? []
      list.push(s)
      members.set(intent, list)
    }
    const workflowBySlug = new Map(input.workflows.map((w) => [w.slug, w]))
    const usedSlugs = new Set<string>()
    for (const [intent, list] of members) {
      let slug = slugify(intent.name)
      while (usedSlugs.has(slug)) slug = `${slug}-2`
      usedSlugs.add(slug)
      const tokens = list.reduce(
        (n, s) =>
          n + Object.values(s.tokens).reduce((m, t) => m + sumTokens(t), 0),
        0,
      )
      intents.push({
        name: intent.name,
        slug,
        description: intent.description,
        sessions: list.length,
        share: total === 0 ? 0 : list.length / total,
        weekly: weeks.map((w) => ({
          weekStart: w,
          count: list.filter((s) => mondayOf(s.start) === w).length,
        })),
        topTools: countBy(
          list.flatMap((s) => s.steps),
          (st) => stepKey(st),
          5,
        ),
        examples: examplePrompts(list, input.llm.redactions),
        projects: countBy(list, (s) => s.projectLabel, 5),
        categories: countBy(list, (s) => input.labels?.get(s.id)?.category),
        labels: countBy(list, (s) => input.labels?.get(s.id)?.intent, 8),
        tokens,
        cost: list.reduce((n, s) => n + sessionCost(s), 0),
        workflow: workflowBySlug.get(slugify(intent.name)) ?? null,
      })
    }
    intents.sort(
      (a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name),
    )
  }

  const wasteItems = sessions.flatMap(detectWaste)
  const byKind = {} as Report['waste']['byKind']
  for (const kind of [
    'loop',
    'repeated-bash',
    'error-streak',
    'interrupt-ended',
  ] as WasteKind[]) {
    const items = wasteItems.filter((w) => w.kind === kind)
    const t = wasteTotals(sessions, items)
    byKind[kind] = { items: items.length, tokens: t.tokens, cost: t.cost }
  }
  const top = [...wasteItems]
    .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.tokens - a.tokens)
    .slice(0, 50)

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    friskVersion: input.friskVersion,
    window: {
      since: input.since,
      from,
      to,
      days: from
        ? Math.max(
            1,
            Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000),
          )
        : 0,
    },
    source: {
      ...input.stats,
      root: input.root,
      filteredByProject: input.filteredByProject,
    },
    llm: input.llm,
    overview: {
      sessions: total,
      prompts: sessions.reduce((n, s) => n + s.prompts.length, 0),
      toolCalls: sessions.reduce((n, s) => n + s.steps.length, 0),
      toolErrors: sessions.reduce((n, s) => n + s.errors, 0),
      interrupts: sessions.reduce((n, s) => n + s.interrupts, 0),
      projects: countBy(sessions, (s) => s.projectLabel),
      models,
      entrypoints: countBy(sessions, (s) => s.entrypoint ?? '(none)'),
      sessionKinds: countBy(sessions, (s) => s.sessionKind ?? 'interactive'),
      categories: input.labels
        ? countBy(
            sessions,
            (s) => input.labels?.get(s.id)?.category ?? 'unlabeled',
          )
        : [],
      tokens: models.reduce((n, m) => n + m.tokens, 0),
      cost: models.reduce((n, m) => n + (m.cost ?? 0), 0),
      unpricedModels: models.filter((m) => m.cost === null).map((m) => m.model),
    },
    intents,
    workflows: input.workflows,
    waste: { totals: wasteTotals(sessions, wasteItems), byKind, top },
    rates: { asOf: RATES_AS_OF, basis: PRICE_BASIS },
    sensitive: input.sensitive,
  }
}

export function typicalSequence(s: Session): string {
  return foldSequence(s.steps, 220)
}
