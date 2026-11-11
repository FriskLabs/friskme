import { compressSteps } from '../lib/sequence-fold.ts'
import { stepKey } from '../parse/tool-step.ts'
import type { Session, ToolStep } from '../types.ts'
import { type ScrubCounts, scrubSecrets } from './scrub-secrets.ts'

export const FIRST_PROMPT_CHARS = 600
export const FOLLOW_UP_CHARS = 200
export const MAX_FOLLOW_UPS = 5
const MAX_SEQUENCE_CHARS = 700

/** Short acknowledgements say nothing about intent. */
function isAck(text: string): boolean {
  return text.trim().split(/\s+/).length < 3
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** Pasted blocks keep their text; the wrapper tags go. */
export function cleanPrompt(text: string): string {
  return text
    .replace(/<pasted_content[^>]*>/g, '[pasted] ')
    .replace(/<\/pasted_content[^>]*>/g, ' ')
}

/** `Read:ts ×4 → [Edit:ts → Bash:package_manager] ×3 → Bash:git` */
export function foldSequence(
  steps: ToolStep[],
  maxChars = MAX_SEQUENCE_CHARS,
): string {
  const items = compressSteps(steps, stepKey).map((item) => {
    if (item.kind === 'step') return stepKey(item.step)
    const body = item.pattern.map(stepKey)
    const label = body.length === 1 ? body[0] : `[${body.join(' → ')}]`
    return `${label} ×${item.repeatCount}`
  })
  let out = ''
  for (let i = 0; i < items.length; i++) {
    const next = out ? `${out} → ${items[i]}` : items[i]!
    if (next.length > maxChars) return `${out} → … (${items.length - i} more)`
    out = next
  }
  return out || '(no tool calls)'
}

/**
 * The compact, scrubbed text a model sees for one session. It carries no id:
 * a batch prefixes a local handle (`[s1]`…) when sending, so the real session
 * id never leaves the machine and the card's hash is stable across batches.
 */
export function buildCard(
  s: Session,
  scrubCounts: ScrubCounts = {},
  /** Extra masking applied before scrubbing, e.g. names found by the PII model. */
  transform: (text: string) => string = (t) => t,
): string {
  const scrub = (t: string) => scrubSecrets(transform(t), scrubCounts)
  const first = s.prompts[0]
  const followUps = s.prompts
    .slice(1)
    .filter((p) => !isAck(p.text))
    .slice(0, MAX_FOLLOW_UPS)
  const lines = [
    `project: ${scrub(s.projectLabel)} · ${s.steps.length} tool calls · ${s.errors} tool errors · ${s.interrupts} interrupts`,
    `First prompt: ${truncate(scrub(cleanPrompt(first?.text ?? '')), FIRST_PROMPT_CHARS)}`,
  ]
  if (followUps.length > 0) {
    lines.push('Follow-ups:')
    for (const p of followUps) {
      // Scrub before truncating, so a cut never splits a secret past its pattern.
      lines.push(`- ${truncate(scrub(cleanPrompt(p.text)), FOLLOW_UP_CHARS)}`)
    }
  }
  lines.push(`Tools: ${foldSequence(s.steps)}`)
  return lines.join('\n')
}
