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
import { readJsonl } from '../../parse/read-jsonl.ts'
import { normalizeCommand, stepKey } from '../../parse/tool-step.ts'
import {
  addTotals,
  emptyTotals,
  type Session,
  type TokenTotals,
} from '../../types.ts'
import { classifyUserLine, commandIsIntent } from './classify-user-line.ts'
import { claudeToolKind, toolDetail, toolDisplayName } from './tools.ts'

/** The text a tool was given: the command for Bash, every string value otherwise. */
export function toolInputText(name: string, input: any): string {
  if (name === 'Bash' && typeof input?.command === 'string')
    return input.command
  return stringValues(input)
}

/** Text of a tool_result: a string, or its text blocks. Images are skipped. */
export function toolResultText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** Line types frisk knows and deliberately does not use. */
export const IGNORED_LINE_TYPES = new Set([
  'attachment',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'last-prompt',
  'mode',
  'permission-mode',
  'atis-latch',
  'ai-title',
  'agent-name',
  'queue-operation',
  'pr-link',
  'bridge-session',
  'file-history-snapshot',
  'file-history-delta',
  'tools-used',
  'session-owner',
  'cost-state',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'frame-link',
  'fork-context-ref',
  'continued-in',
  'summary',
  'progress',
])

const USED_LINE_TYPES = new Set(['user', 'assistant', 'system'])

function usageTotals(usage: any): TokenTotals {
  const n = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0
  const creation = usage?.cache_creation
  const write1h = n(creation?.ephemeral_1h_input_tokens)
  const write5mExplicit = creation?.ephemeral_5m_input_tokens
  const writeTotal = n(usage?.cache_creation_input_tokens)
  // Older transcripts carry only the total; it is priced as 5-minute writes.
  const write5m =
    typeof write5mExplicit === 'number' ? write5mExplicit : writeTotal - write1h
  return {
    input: n(usage?.input_tokens),
    output: n(usage?.output_tokens),
    cacheWrite5m: Math.max(0, write5m),
    cacheWrite1h: write1h,
    cacheRead: n(usage?.cache_read_input_tokens),
  }
}

function countType(counters: FileCounters, type: unknown): void {
  countLineType(counters, type, IGNORED_LINE_TYPES)
}

/**
 * Folds one top-level transcript into a Session. Usage is deduplicated by
 * `message.id`: one API response is written as several assistant lines (one
 * per content block), each repeating the same usage.
 */
export async function parseSessionFile(
  path: string,
  counters: FileCounters,
  onText?: TextVisitor,
): Promise<ParseOutcome> {
  const id = basename(path).replace(/\.jsonl$/, '')
  const s: Session = emptySession(id, 'claude')
  const models = new Set<string>()
  const stepByToolUseId = new Map<string, number>()
  const bashByToolUseId = new Map<string, number>()
  let turnMessageIds: string[] = []

  for await (const line of readJsonl(path)) {
    if (!line.ok) {
      counters.malformedLines++
      continue
    }
    if (line.fastType !== undefined) {
      countType(counters, line.fastType)
      continue
    }
    const o = line.value
    const type = o.type
    if (!USED_LINE_TYPES.has(type)) {
      countType(counters, type)
      continue
    }

    if (typeof o.timestamp === 'string') {
      if (!s.start || o.timestamp < s.start) s.start = o.timestamp
      if (!s.end || o.timestamp > s.end) s.end = o.timestamp
    }
    if (!s.project && typeof o.cwd === 'string' && o.cwd.length > 0) {
      s.project = o.cwd
      s.projectLabel = basename(o.cwd) || o.cwd
      s.branch =
        typeof o.gitBranch === 'string' && o.gitBranch ? o.gitBranch : null
    }
    if (!s.entrypoint && typeof o.entrypoint === 'string')
      s.entrypoint = o.entrypoint
    if (!s.sessionKind && typeof o.sessionKind === 'string') {
      s.sessionKind = o.sessionKind
    }

    if (type === 'system') {
      if (o.subtype === 'compact_boundary') s.compactions++
      continue
    }

    if (type === 'assistant') {
      const msg = o.message ?? {}
      const messageId = String(msg.id ?? o.requestId ?? o.uuid ?? '')
      const model = typeof msg.model === 'string' ? msg.model : 'unknown'
      if (model !== '<synthetic>' && messageId && !s.messageUsage[messageId]) {
        const totals = usageTotals(msg.usage)
        s.messageUsage[messageId] = { model, totals }
        models.add(model)
        s.tokens[model] ??= emptyTotals()
        addTotals(s.tokens[model], totals)
        turnMessageIds.push(messageId)
      }
      s.endedAfterInterrupt = false
      const blocks = Array.isArray(msg.content) ? msg.content : []
      const ts = String(o.timestamp ?? '')
      for (const b of blocks) {
        if (onText && b?.type === 'text' && typeof b.text === 'string') {
          onText({
            source: 'assistant-text',
            tool: null,
            ts,
            text: clip(b.text),
          })
        }
        if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
        const toolUseId = String(b.id ?? '')
        stepByToolUseId.set(toolUseId, s.steps.length)
        s.steps.push({
          tool: toolDisplayName(b.name),
          kind: claudeToolKind(b.name),
          detail: toolDetail(b.name, b.input),
          isError: false,
          messageId,
          toolUseId,
          ts: String(o.timestamp ?? ''),
        })
        if (onText) {
          onText({
            source: 'tool-input',
            tool: stepKey(s.steps[s.steps.length - 1]!),
            ts,
            text: clip(toolInputText(b.name, b.input)),
          })
        }
        if (b.name === 'Bash' && typeof b.input?.command === 'string') {
          bashByToolUseId.set(toolUseId, s.bashRuns.length)
          s.bashRuns.push({
            normalized: normalizeCommand(b.input.command),
            messageId,
            isError: false,
          })
        }
      }
      continue
    }

    // type === 'user'
    if (typeof o.toolDenialKind === 'string') s.denials++
    const c = classifyUserLine(o)
    if (onText) {
      visitUserText(o, c, onText, (id) => {
        const si = stepByToolUseId.get(id)
        return si === undefined ? null : stepKey(s.steps[si]!)
      })
    }
    switch (c.kind) {
      case 'tool_result':
        for (const r of c.results) {
          if (!r.isError) continue
          s.errors++
          const si = stepByToolUseId.get(r.toolUseId)
          if (si !== undefined) s.steps[si]!.isError = true
          const bi = bashByToolUseId.get(r.toolUseId)
          if (bi !== undefined) s.bashRuns[bi]!.isError = true
        }
        break
      case 'human':
        s.prompts.push({
          text: c.text,
          ts: String(o.timestamp ?? ''),
          source: c.source,
        })
        turnMessageIds = []
        s.endedAfterInterrupt = false
        break
      case 'command':
        s.slashCommands.push(c.name)
        if (commandIsIntent(c.name, c.args)) {
          s.prompts.push({
            text: `/${c.name} ${c.args}`,
            ts: String(o.timestamp ?? ''),
            source: 'command',
          })
          turnMessageIds = []
          s.endedAfterInterrupt = false
        }
        break
      case 'interrupt':
        s.interrupts++
        s.endedAfterInterrupt = true
        s.interruptedTurnMessageIds = [...turnMessageIds]
        break
      default:
        break
    }
  }

  s.models = [...models].sort()
  return finishSession(s)
}

function visitUserText(
  o: any,
  c: ReturnType<typeof classifyUserLine>,
  onText: TextVisitor,
  toolOf: (toolUseId: string) => string | null,
): void {
  const ts = String(o.timestamp ?? '')
  if (c.kind === 'human') {
    onText({ source: 'typed-prompt', tool: null, ts, text: clip(c.text) })
  } else if (c.kind === 'command' && c.args) {
    onText({
      source: 'slash-command',
      tool: `/${c.name}`,
      ts,
      text: clip(c.args),
    })
  } else if (c.kind === 'compact_summary') {
    onText({
      source: 'compact-summary',
      tool: null,
      ts,
      text: clip(toolResultText(o.message?.content)),
    })
  } else if (c.kind === 'tool_result') {
    const blocks = Array.isArray(o.message?.content) ? o.message.content : []
    for (const b of blocks) {
      if (b?.type !== 'tool_result') continue
      const text = toolResultText(b.content)
      if (!text) continue
      onText({
        source: 'tool-output',
        tool: toolOf(String(b.tool_use_id ?? '')),
        ts,
        text: clip(text),
      })
    }
  }
  // Harness text (system reminders, task notifications, peer messages) is not scanned.
}

/** Usage from one subagent transcript, deduplicated by message id. */
export async function parseSubagentFile(
  path: string,
  counters: FileCounters,
  onText?: TextVisitor,
): Promise<Record<string, TokenTotals>> {
  const seen = new Set<string>()
  const byModel: Record<string, TokenTotals> = {}
  for await (const line of readJsonl(path)) {
    if (!line.ok) {
      counters.malformedLines++
      continue
    }
    if (line.fastType !== undefined) continue
    const o = line.value
    if (onText) visitSubagentText(o, onText)
    if (o.type !== 'assistant') continue
    const msg = o.message ?? {}
    const id = String(msg.id ?? o.requestId ?? o.uuid ?? '')
    const model = typeof msg.model === 'string' ? msg.model : 'unknown'
    if (!id || seen.has(id) || model === '<synthetic>') continue
    seen.add(id)
    byModel[model] ??= emptyTotals()
    addTotals(byModel[model], usageTotals(msg.usage))
  }
  return byModel
}

/** Everything a subagent read, ran or wrote, as one `subagent` source. */
function visitSubagentText(o: any, onText: TextVisitor): void {
  const ts = String(o.timestamp ?? '')
  const blocks = Array.isArray(o.message?.content) ? o.message.content : []
  for (const b of blocks) {
    let text = ''
    let tool: string | null = null
    if (o.type === 'assistant' && b?.type === 'text')
      text = String(b.text ?? '')
    else if (o.type === 'assistant' && b?.type === 'tool_use') {
      tool = toolDisplayName(String(b.name ?? ''))
      text = toolInputText(String(b.name ?? ''), b.input)
    } else if (o.type === 'user' && b?.type === 'tool_result') {
      text = toolResultText(b.content)
    }
    if (text) onText({ source: 'subagent', tool, ts, text: clip(text) })
  }
}
