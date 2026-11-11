import { truncate } from '../card/build-card.ts'
import { scrubSecrets } from '../card/scrub-secrets.ts'
import { compressSteps } from '../lib/sequence-fold.ts'
import { stepKey } from '../parse/tool-step.ts'
import {
  addTotals,
  emptyTotals,
  type Session,
  sumTokens,
  type TokenTotals,
} from '../types.ts'
import { priceTokens } from './rate-table.ts'

export const MIN_LOOP_REPEATS = 3
export const MIN_BASH_REPEATS = 3
export const MIN_ERROR_STREAK = 3
export const MIN_FAILING_ITERATIONS = 2

function countFailingIterations(
  steps: { isError: boolean }[],
  patternLength: number,
): number {
  let n = 0
  for (let i = 0; i < steps.length; i += patternLength) {
    if (steps.slice(i, i + patternLength).some((st) => st.isError)) n++
  }
  return n
}

export type WasteKind =
  | 'loop'
  | 'repeated-bash'
  | 'error-streak'
  | 'interrupt-ended'

export type WasteItem = {
  kind: WasteKind
  sessionId: string
  project: string
  start: string
  /** Human-readable: the folded pattern, the command, the streak. */
  label: string
  /** Edit → run → error loops are called out separately. */
  editRunError: boolean
  occurrences: number
  /** Assistant messages whose usage this item is priced from. */
  messageIds: string[]
  tokens: number
  /** USD, or null when a model in the span has no rate. */
  cost: number | null
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function price(
  s: Session,
  messageIds: string[],
): { tokens: number; cost: number | null } {
  let tokens = 0
  let cost: number | null = 0
  for (const id of messageIds) {
    const u = s.messageUsage[id]
    if (!u) continue
    tokens += sumTokens(u.totals)
    const p = priceTokens(u.model, u.totals)
    cost = p === null || cost === null ? null : cost + p
  }
  return { tokens, cost }
}

function unique(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))]
}

function item(
  s: Session,
  kind: WasteKind,
  label: string,
  occurrences: number,
  messageIds: string[],
  editRunError = false,
): WasteItem {
  const ids = unique(messageIds)
  return {
    kind,
    sessionId: s.id,
    project: s.projectLabel,
    start: s.start,
    label,
    editRunError,
    occurrences,
    messageIds: ids,
    ...price(s, ids),
  }
}

/**
 * A folded group repeated 3+ times counts as a wasted loop only when it kept
 * failing: at least 2 iterations, and at least half of them, contain an
 * erroring step. That is the agent retrying something that does not work.
 * An error-free run of reads, searches or `git` calls is exploration, and an
 * edit → run cycle that passes is ordinary iteration; neither is waste.
 */
export function detectLoops(s: Session): WasteItem[] {
  const out: WasteItem[] = []
  for (const g of compressSteps(s.steps, stepKey)) {
    if (g.kind !== 'group' || g.repeatCount < MIN_LOOP_REPEATS) continue
    const hasEdit = g.pattern.some((p) => EDIT_TOOLS.has(p.tool))
    const hasRun = g.pattern.some((p) => p.tool === 'Bash')
    const failingIterations = countFailingIterations(g.steps, g.pattern.length)
    if (
      failingIterations < MIN_FAILING_ITERATIONS ||
      failingIterations * 2 < g.repeatCount
    )
      continue
    const errored = failingIterations > 0
    const body = g.pattern.map(stepKey)
    const label = `${body.length === 1 ? body[0] : `[${body.join(' → ')}]`} ×${g.repeatCount}`
    // The first pass through the pattern was needed; the repeats are the waste.
    const repeats = g.steps.slice(g.pattern.length).map((p) => p.messageId)
    out.push(
      item(
        s,
        'loop',
        label,
        g.repeatCount,
        repeats,
        hasEdit && hasRun && errored,
      ),
    )
  }
  return out
}

export function detectRepeatedBash(s: Session): WasteItem[] {
  const groups = new Map<string, typeof s.bashRuns>()
  for (const r of s.bashRuns) {
    const list = groups.get(r.normalized) ?? []
    list.push(r)
    groups.set(r.normalized, list)
  }
  const out: WasteItem[] = []
  for (const [command, runs] of groups) {
    if (runs.length < MIN_BASH_REPEATS) continue
    // `sleep N; check` repeated is deliberate polling, not a wasted retry.
    if (/^sleep\s/.test(command)) continue
    const failed = runs.filter((r) => r.isError).length
    const label = `\`${truncate(scrubSecrets(command), 80)}\` run ${runs.length}×${failed > 0 ? ` (${failed} failed)` : ''}`
    // The first run was needed; the repeats are the waste.
    out.push(
      item(
        s,
        'repeated-bash',
        label,
        runs.length,
        runs.slice(1).map((r) => r.messageId),
      ),
    )
  }
  return out
}

export function detectErrorStreaks(s: Session): WasteItem[] {
  const out: WasteItem[] = []
  let run: typeof s.steps = []
  const flush = () => {
    if (run.length >= MIN_ERROR_STREAK) {
      const tools = unique(run.map(stepKey)).join(', ')
      out.push(
        item(
          s,
          'error-streak',
          `${run.length} failed tool calls in a row (${tools})`,
          run.length,
          run.map((r) => r.messageId),
        ),
      )
    }
    run = []
  }
  for (const step of s.steps) {
    if (step.isError) run.push(step)
    else flush()
  }
  flush()
  return out
}

export function detectInterruptEnded(s: Session): WasteItem[] {
  if (!s.endedAfterInterrupt) return []
  return [
    item(
      s,
      'interrupt-ended',
      'Session ended right after you interrupted the agent',
      1,
      s.interruptedTurnMessageIds,
    ),
  ]
}

export function detectWaste(s: Session): WasteItem[] {
  return [
    ...detectLoops(s),
    ...detectRepeatedBash(s),
    ...detectErrorStreaks(s),
    ...detectInterruptEnded(s),
  ]
}

export type WasteTotals = {
  items: number
  sessionsAffected: number
  tokens: number
  cost: number
  /** Items whose span included a model with no rate. */
  unpricedItems: number
}

/**
 * Totals across items, pricing each assistant message once even when several
 * detectors flag it.
 */
export function wasteTotals(
  sessions: Session[],
  items: WasteItem[],
): WasteTotals {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const totals: TokenTotals = emptyTotals()
  let cost = 0
  for (const it of items) {
    const s = byId.get(it.sessionId)
    if (!s) continue
    for (const id of it.messageIds) {
      const key = `${s.id}:${id}`
      if (seen.has(key)) continue
      seen.add(key)
      const u = s.messageUsage[id]
      if (!u) continue
      addTotals(totals, u.totals)
      cost += priceTokens(u.model, u.totals) ?? 0
    }
  }
  return {
    items: items.length,
    sessionsAffected: new Set(items.map((i) => i.sessionId)).size,
    tokens: sumTokens(totals),
    cost,
    unpricedItems: items.filter((i) => i.cost === null).length,
  }
}
