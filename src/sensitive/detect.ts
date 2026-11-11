import { detectPii } from './rules/pii.ts'
import {
  rejectSecretValue,
  SECRET_RULES,
  type SecretRule,
} from './rules/secrets.ts'
import type { Detection } from './types.ts'

export type DetectOptions = { secrets?: boolean; pii?: boolean }

function runRule(rule: SecretRule, text: string, out: Detection[]): void {
  rule.regex.lastIndex = 0
  for (const m of text.matchAll(rule.regex)) {
    const value = (rule.group ? m[rule.group] : m[0]) ?? ''
    if (!value || rejectSecretValue(rule, value)) continue
    out.push({
      kind: 'secret',
      type: rule.type,
      confidence: rule.confidence,
      detector: `rule:${rule.id}`,
      value,
    })
  }
}

/**
 * Every secret and structured-PII match in one text. A rule's regex runs only
 * when the text contains one of its keywords. When two secret rules capture
 * the same value, the more specific (earlier, higher-confidence) one wins.
 */
export function detectInText(
  text: string,
  opts: DetectOptions = {},
): Detection[] {
  if (text.length === 0) return []
  const out: Detection[] = []
  if (opts.secrets !== false) {
    const lower = text.toLowerCase()
    for (const rule of SECRET_RULES) {
      if (rule.keywords.some((k) => lower.includes(k))) runRule(rule, text, out)
    }
  }
  if (opts.pii !== false) out.push(...detectPii(text))
  return dedupe(out)
}

const RANK = { high: 0, medium: 1, low: 2 } as const

function dedupe(found: Detection[]): Detection[] {
  const byValue = new Map<string, Detection>()
  for (const d of found) {
    const prev = byValue.get(d.value)
    if (!prev || RANK[d.confidence] < RANK[prev.confidence])
      byValue.set(d.value, d)
  }
  // A secret contained in a longer one (a key inside a URL) is reported once, as the longer match.
  const values = [...byValue.keys()]
  return [...byValue.values()].filter(
    (d) =>
      d.kind !== 'secret' ||
      !values.some(
        (v) =>
          v !== d.value &&
          v.includes(d.value) &&
          byValue.get(v)?.kind === 'secret',
      ),
  )
}
