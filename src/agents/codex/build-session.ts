import { basename } from 'node:path'
import {
  clip,
  countLineType,
  emptySession,
  type FileCounters,
  finishSession,
  type ParseOutcome,
  stringValues,
  type TextVisitor,
} from '../../parse/common.ts'
import { normalizeCommand, stepKey } from '../../parse/tool-step.ts'
import {
  addTotals,
  emptyTotals,
  type Session,
  sumTokens,
  type TokenTotals,
} from '../../types.ts'
import { readRollout } from './read-rollout.ts'
import {
  codexToolDetail,
  codexToolDisplayName,
  codexToolKind,
  outputIsError,
  outputText,
  shellCommand,
} from './tools.ts'

/** Top-level record types frisk reads. */
const USED_TYPES = new Set([
  'session_meta',
  'turn_context',
  'response_item',
  'event_msg',
  'compacted',
  'token_usage_record',
])
/** Record types frisk knows and deliberately does not use. */
export const IGNORED_TYPES = new Set(['world_state'])

const CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
])
const OUTPUT_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'local_shell_call_output',
])

/** A leading `<tag …>…</tag>` block, which Codex injects and a person never types. */
const LEADING_TAG_BLOCK = /^<([A-Za-z_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/

/**
 * The part of a user message a person typed, or null when Codex injected all
 * of it. Injected blocks are tag-wrapped (`<environment_context>`,
 * `<subagent_notification>`, `<turn_aborted>`, `<system_instruction>`, …) and
 * may be prepended to the typed text, so leading blocks are stripped. The
 * AGENTS.md preamble is dropped, and of the VS Code extension's
 * `# Context from my IDE setup:` wrapper only the part under
 * `## My request for Codex:` is kept.
 */
export function typedText(raw: string): string | null {
  let text = raw.trim()
  if (/^# AGENTS\.md instructions\b/.test(text)) return null
  for (let i = 0; i < 16; i++) {
    const m = text.match(LEADING_TAG_BLOCK)
    if (!m) break
    text = text.slice(m[0].length)
  }
  if (/^# Context from my IDE setup\b/.test(text)) {
    const parts = text.split(/^## My request for Codex:[^\n]*$/m)
    text = parts.length > 1 ? parts[parts.length - 1]!.trim() : ''
  }
  text = text.trim()
  return text || null
}

type RawUsage = Record<string, unknown> | null | undefined

/**
 * Codex reports usage the OpenAI way: `input_tokens` counts every input token,
 * cached reads (and cache writes, where a model has them) included. frisk's
 * TokenTotals keep them apart, as Anthropic reports them, so input is the
 * remainder after both. Reasoning tokens are already inside `output_tokens`.
 */
export function codexTotals(u: RawUsage): TokenTotals {
  const n = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
  const input = n(u?.input_tokens)
  const cached = Math.min(n(u?.cached_input_tokens), input)
  const written = Math.min(n(u?.cache_write_input_tokens), input - cached)
  return {
    input: input - cached - written,
    output: n(u?.output_tokens),
    cacheWrite5m: written,
    cacheWrite1h: 0,
    cacheRead: cached,
  }
}

function sameUsage(a: RawUsage, b: RawUsage): boolean {
  if (!a || !b) return false
  return (
    a.input_tokens === b.input_tokens &&
    a.cached_input_tokens === b.cached_input_tokens &&
    a.output_tokens === b.output_tokens &&
    a.total_tokens === b.total_tokens
  )
}

function parseArgs(raw: unknown): any {
  if (typeof raw !== 'string') return raw ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function userMessageText(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((c: any) => c?.type === 'input_text' && typeof c.text === 'string')
    .map((c: any) => c.text as string)
}

function assistantMessageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c: any) => c?.type === 'output_text' && typeof c.text === 'string')
    .map((c: any) => c.text as string)
    .join('\n')
}

/**
 * Folds one rollout into a Session, whether or not it has a typed prompt
 * (subagent rollouts have none of their own). Read twice over: one pass to see
 * which of Codex's redundant record kinds this file carries, one to fold.
 */
export async function foldRollout(
  path: string,
  counters: FileCounters,
  onText?: TextVisitor,
): Promise<Session> {
  const records: any[] = []
  for await (const line of readRollout(path)) {
    if (!line.ok) {
      counters.malformedLines++
      continue
    }
    if (line.fastType !== undefined) continue
    records.push(line.value)
  }
  // Older builds log each typed prompt as `event_msg/user_message`; newer ones
  // only as a user `response_item`. Newer builds also log per-response usage
  // (`token_usage_record`) next to the cumulative `token_count` events.
  const hasUserEvents = records.some(
    (o) => o.type === 'event_msg' && o.payload?.type === 'user_message',
  )
  const hasUsageRecords = records.some((o) => o.type === 'token_usage_record')

  const fallbackId = (basename(path).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  ) ?? [])[1]
  const s = emptySession(fallbackId ?? basename(path), 'codex')
  const models = new Set<string>()
  let model = 'unknown'
  const stepByCallId = new Map<string, number>()
  const bashByCallId = new Map<string, number>()
  let pendingSteps: number[] = []
  let pendingBash: number[] = []
  let turnMessageIds: string[] = []
  let lastTokenCount: RawUsage = null
  let usageSeq = 0

  const addUsage = (id: string, totals: TokenTotals) => {
    if (sumTokens(totals) === 0 || s.messageUsage[id]) return
    const m = model
    s.messageUsage[id] = { model: m, totals }
    models.add(m)
    const bucket = (s.tokens[m] ??= emptyTotals())
    addTotals(bucket, totals)
    // Usage is logged after the response it pays for, so the tool calls that
    // response made are waiting for their message id.
    for (const i of pendingSteps) s.steps[i]!.messageId = id
    for (const i of pendingBash) s.bashRuns[i]!.messageId = id
    pendingSteps = []
    pendingBash = []
    turnMessageIds.push(id)
  }

  const addPrompt = (text: string, ts: string) => {
    s.prompts.push({ text, ts, source: 'typed' })
    onText?.({ source: 'typed-prompt', tool: null, ts, text: clip(text) })
    turnMessageIds = []
    s.endedAfterInterrupt = false
  }

  for (const o of records) {
    const type = o.type
    if (!USED_TYPES.has(type)) {
      countLineType(counters, type, IGNORED_TYPES)
      continue
    }
    const ts = typeof o.timestamp === 'string' ? o.timestamp : ''
    if (ts) {
      if (!s.start || ts < s.start) s.start = ts
      if (!s.end || ts > s.end) s.end = ts
    }
    const p = o.payload ?? {}

    if (type === 'session_meta') {
      if (typeof p.id === 'string' && p.id) s.id = p.id
      if (!s.project && typeof p.cwd === 'string' && p.cwd) {
        s.project = p.cwd
        s.projectLabel = basename(p.cwd) || p.cwd
      }
      const branch = p.git?.branch
      if (!s.branch && typeof branch === 'string' && branch) s.branch = branch
      if (!s.entrypoint && typeof p.source === 'string') s.entrypoint = p.source
      continue
    }

    if (type === 'turn_context') {
      if (typeof p.model === 'string' && p.model) model = p.model
      if (!s.project && typeof p.cwd === 'string' && p.cwd) {
        s.project = p.cwd
        s.projectLabel = basename(p.cwd) || p.cwd
      }
      continue
    }

    if (type === 'compacted') {
      s.compactions++
      if (onText && typeof p.message === 'string' && p.message) {
        onText({
          source: 'compact-summary',
          tool: null,
          ts,
          text: clip(p.message),
        })
      }
      continue
    }

    if (type === 'token_usage_record') {
      const id =
        typeof p.response_id === 'string' && p.response_id
          ? p.response_id
          : `u${++usageSeq}`
      addUsage(id, codexTotals(p.usage))
      continue
    }

    if (type === 'event_msg') {
      switch (p.type) {
        case 'user_message': {
          const text =
            typeof p.message === 'string' ? typedText(p.message) : null
          if (text) addPrompt(text, ts)
          break
        }
        case 'token_count': {
          if (hasUsageRecords) break
          const total = p.info?.total_token_usage
          // The same totals are re-logged (rate-limit refreshes); only a change is new usage.
          if (!total || sameUsage(total, lastTokenCount)) break
          lastTokenCount = total
          addUsage(`u${++usageSeq}`, codexTotals(p.info?.last_token_usage))
          break
        }
        case 'turn_aborted':
          if (p.reason === 'interrupted') {
            s.interrupts++
            s.endedAfterInterrupt = true
            s.interruptedTurnMessageIds = [...turnMessageIds]
          }
          break
        default:
          break
      }
      continue
    }

    // type === 'response_item'
    if (p.type === 'message') {
      if (p.role === 'user') {
        if (hasUserEvents) continue
        const typed = userMessageText(p.content)
          .map(typedText)
          .filter((t): t is string => t !== null)
        if (typed.length > 0) addPrompt(typed.join('\n\n'), ts)
      } else if (p.role === 'assistant') {
        s.endedAfterInterrupt = false
        const text = assistantMessageText(p.content)
        if (onText && text) {
          onText({ source: 'assistant-text', tool: null, ts, text: clip(text) })
        }
      }
      continue
    }

    if (CALL_TYPES.has(p.type)) {
      const name =
        typeof p.name === 'string'
          ? p.name
          : p.type === 'local_shell_call'
            ? 'local_shell'
            : ''
      if (!name) continue
      const args =
        p.type === 'custom_tool_call'
          ? p.input
          : p.type === 'local_shell_call'
            ? p.action
            : parseArgs(p.arguments)
      const callId = String(p.call_id ?? p.id ?? '')
      s.endedAfterInterrupt = false
      stepByCallId.set(callId, s.steps.length)
      pendingSteps.push(s.steps.length)
      s.steps.push({
        tool: codexToolDisplayName(name),
        kind: codexToolKind(name),
        detail: codexToolDetail(name, args),
        isError: false,
        messageId: '',
        toolUseId: callId,
        ts,
      })
      const key = stepKey(s.steps[s.steps.length - 1]!)
      const command =
        codexToolKind(name) === 'shell' ? shellCommand(name, args) : null
      if (command !== null) {
        bashByCallId.set(callId, s.bashRuns.length)
        pendingBash.push(s.bashRuns.length)
        s.bashRuns.push({
          normalized: normalizeCommand(command),
          messageId: '',
          isError: false,
        })
      }
      if (onText) {
        const text =
          command ?? (typeof args === 'string' ? args : stringValues(args))
        if (text)
          onText({ source: 'tool-input', tool: key, ts, text: clip(text) })
      }
      continue
    }

    if (OUTPUT_TYPES.has(p.type)) {
      const callId = String(p.call_id ?? '')
      const si = stepByCallId.get(callId)
      if (outputIsError(p.output)) {
        s.errors++
        if (si !== undefined) s.steps[si]!.isError = true
        const bi = bashByCallId.get(callId)
        if (bi !== undefined) s.bashRuns[bi]!.isError = true
      }
      if (onText) {
        const text = outputText(p.output)
        if (text) {
          onText({
            source: 'tool-output',
            tool: si === undefined ? null : stepKey(s.steps[si]!),
            ts,
            text: clip(text),
          })
        }
      }
      continue
    }

    if (p.type === 'web_search_call') {
      s.steps.push({
        tool: 'web_search',
        kind: 'other',
        detail: null,
        isError: false,
        messageId: '',
        toolUseId: String(p.id ?? ''),
        ts,
      })
      pendingSteps.push(s.steps.length - 1)
    }
    // Reasoning is encrypted and other items carry nothing frisk uses.
  }

  s.models = [...models].sort()
  return s
}

export async function parseCodexSession(
  path: string,
  counters: FileCounters,
  onText?: TextVisitor,
): Promise<ParseOutcome> {
  return finishSession(await foldRollout(path, counters, onText))
}

/** Usage by model from a subagent's rollout; its text is scanned as `subagent`. */
export async function parseCodexSubagent(
  path: string,
  counters: FileCounters,
  onText?: TextVisitor,
): Promise<Record<string, TokenTotals>> {
  const visit: TextVisitor | undefined = onText
    ? (v) => onText({ ...v, source: 'subagent' })
    : undefined
  const s = await foldRollout(path, counters, visit)
  return s.tokens
}
