import { type Cache, sha256 } from '../cache.ts'
import type { ClaudeRunner } from './claude-runner.ts'
import {
  GROUP_SCHEMA,
  type GroupedIntent,
  type GroupInput,
  groupPrompt,
  groupValidator,
  PROMPT_VERSION,
} from './prompts.ts'

export type GroupPassResult = {
  intents: GroupedIntent[]
  /** Labels the model left out; they were placed in an "Other" intent. */
  unassigned: number
  /** True when grouping failed twice and labels were grouped by category instead. */
  fellBackToCategories: boolean
  cached: boolean
}

export const OTHER_INTENT = 'Other work'

/**
 * The reduce pass. The model sees only distinct labels with counts and
 * categories, never transcript text. All counting happens in code.
 */
export async function runGroupPass(opts: {
  inputs: GroupInput[]
  runner: ClaudeRunner
  cache: Cache
  model: string
}): Promise<GroupPassResult> {
  const inputs = [...opts.inputs].sort((a, b) => a.label.localeCompare(b.label))
  const labels = inputs.map((i) => i.label)
  const key = sha256(
    `${PROMPT_VERSION}\n${opts.model}\n${inputs.map((i) => `${i.label}|${i.count}|${i.category}`).join('\n')}`,
  )
  const cached = opts.cache.get<GroupPassResult>('groups', key)
  if (cached) return { ...cached, cached: true }

  const out = await opts.runner.run(
    groupPrompt(inputs),
    GROUP_SCHEMA,
    groupValidator(labels),
  )
  let result: GroupPassResult
  if (out.ok) {
    const intents = [...out.value.intents]
    if (out.value.unassigned.length > 0) {
      const other = intents.find((i) => i.name === OTHER_INTENT)
      if (other) other.labels.push(...out.value.unassigned)
      else {
        intents.push({
          name: OTHER_INTENT,
          description: 'Labels the grouping step did not place in any intent.',
          labels: out.value.unassigned,
        })
      }
    }
    result = {
      intents,
      unassigned: out.value.unassigned.length,
      fellBackToCategories: false,
      cached: false,
    }
    opts.cache.set('groups', key, result)
  } else {
    result = {
      intents: groupByCategory(inputs),
      unassigned: 0,
      fellBackToCategories: true,
      cached: false,
    }
  }
  return result
}

/** Deterministic fallback: one intent per work category. Not cached, so a re-run retries. */
export function groupByCategory(inputs: GroupInput[]): GroupedIntent[] {
  const byCategory = new Map<string, string[]>()
  for (const i of inputs) {
    const list = byCategory.get(i.category) ?? []
    list.push(i.label)
    byCategory.set(i.category, list)
  }
  return [...byCategory.entries()].map(([category, labels]) => ({
    name: category.charAt(0).toUpperCase() + category.slice(1),
    description: `Sessions labeled as ${category} (grouped by category because the grouping call failed).`,
    labels,
  }))
}
