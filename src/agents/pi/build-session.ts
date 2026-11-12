import { existsSync } from 'node:fs'
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
  sumTokens,
  type TokenTotals,
} from '../../types.ts'
import {
  piShellCommand,
  piToolDetail,
  piToolDisplayName,
  piToolKind,
} from './tools.ts'

/** Entry types frisk reads. */
const USED_TYPES = new Set([
  'session',
  'message',
  'model_change',
  'compaction',
  'branch_summary',
  'usage',
])
/** Entry types frisk knows and deliberately does not use. */
export const IGNORED_TYPES = new Set([
  'thinking_level_change',
  'context_edit',
  'custom',
  'custom_message',
  'label',
  'session_info',
])

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/** `<skill name="X" location="…">…</skill>`, then optional arguments. */
const SKILL_BLOCK =
  /^<skill name="([^"]+)"[^>]*>\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/

/**
 * pi normalizes every provider's usage the Anthropic way: input excludes
 * cache reads and writes, reasoning is inside output. `cacheWrite1h` is the
 * part of `cacheWrite` kept for an hour; the rest is the short TTL.
 */
export function piTotals(u: any): TokenTotals {
  const n = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
  const write = n(u?.cacheWrite)
  const write1h = Math.min(n(u?.cacheWrite1h), write)
  return {
    input: n(u?.input),
    output: n(u?.output),
    cacheWrite5m: write - write1h,
    cacheWrite1h: write1h,
    cacheRead: n(u?.cacheRead),
  }
}

/** `anthropic/claude-opus-5-5` (OpenRouter and the like) → `claude-opus-5-5`. */
export function piModel(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  const slash = raw.lastIndexOf('/')
  return slash >= 0 ? raw.slice(slash + 1) || null : raw
}

function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
    .map((c: any) => c.text as string)
}

/** What a user message is: a `/skill:` command, typed text, or nothing. */
export function classifyUserText(
  raw: string,
):
  | { kind: 'skill'; name: string; args: string }
  | { kind: 'typed'; text: string }
  | null {
  const m = raw.match(SKILL_BLOCK)
  if (m) return { kind: 'skill', name: m[1]!, args: (m[2] ?? '').trim() }
  const text = raw.trim()
  return text ? { kind: 'typed', text } : null
}

/**
 * Entry ids of the session a fork or clone was made from. pi copies the
 * parent's entries into the new file with their ids unchanged, so those are
 * counted with the parent, not again here. Read-only.
 */
async function parentEntryIds(
  parentPath: unknown,
  self: string,
): Promise<Set<string>> {
  const ids = new Set<string>()
  if (typeof parentPath !== 'string' || !parentPath || parentPath === self)
    return ids
  if (!existsSync(parentPath)) return ids
  for await (const line of readJsonl(parentPath)) {
    if (
      line.ok &&
      typeof line.value?.id === 'string' &&
      line.value.type !== 'session'
    )
      ids.add(line.value.id)
  }
  return ids
}

/**
 * Folds one pi session file into a Session. The file is a tree (`id` /
 * `parentId`); every branch in it is folded in file order, because abandoned
 * branches were still paid for.
 */
export async function parsePiSession(
  path: string,
  counters: FileCounters,
  onText?: TextVisitor,
): Promise<ParseOutcome> {
  const records: any[] = []
  for await (const line of readJsonl(path)) {
    if (!line.ok) {
      counters.malformedLines++
      continue
    }
    if (line.fastType !== undefined) continue
    records.push(line.value)
  }

  const header = records.find((o) => o.type === 'session')
  const inherited = await parentEntryIds(header?.parentSession, path)

  const fallbackId = (basename(path).match(UUID) ?? [])[1]
  const s = emptySession(fallbackId ?? basename(path), 'pi')
  const models = new Set<string>()
  let model = 'unknown'
  const stepByCallId = new Map<string, number>()
  const bashByCallId = new Map<string, number>()
  let turnMessageIds: string[] = []

  const addUsage = (id: string, m: string, raw: any) => {
    const totals = piTotals(raw)
    if (sumTokens(totals) === 0 || s.messageUsage[id]) return
    s.messageUsage[id] = { model: m, totals }
    models.add(m)
    addTotals((s.tokens[m] ??= emptyTotals()), totals)
  }

  for (const o of records) {
    const type = o.type
    if (!USED_TYPES.has(type)) {
      countLineType(counters, type, IGNORED_TYPES)
      continue
    }
    if (type !== 'session' && typeof o.id === 'string' && inherited.has(o.id))
      continue
    const ts = typeof o.timestamp === 'string' ? o.timestamp : ''
    if (ts) {
      if (!s.start || ts < s.start) s.start = ts
      if (!s.end || ts > s.end) s.end = ts
    }
    const entryId = typeof o.id === 'string' ? o.id : ''

    if (type === 'session') {
      if (typeof o.id === 'string' && o.id) s.id = o.id
      if (typeof o.cwd === 'string' && o.cwd) {
        s.project = o.cwd
        s.projectLabel = basename(o.cwd) || o.cwd
      }
      continue
    }

    if (type === 'model_change') {
      model = piModel(o.modelId) ?? model
      continue
    }

    if (type === 'usage') {
      addUsage(entryId, piModel(o.model) ?? model, o.usage)
      continue
    }

    if (type === 'compaction' || type === 'branch_summary') {
      if (type === 'compaction') s.compactions++
      if (onText && typeof o.summary === 'string' && o.summary) {
        onText({
          source: 'compact-summary',
          tool: null,
          ts,
          text: clip(o.summary),
        })
      }
      if (o.usage) addUsage(entryId, model, o.usage)
      continue
    }

    // type === 'message'
    const msg = o.message ?? {}
    switch (msg.role) {
      case 'user': {
        const parsed = classifyUserText(textBlocks(msg.content).join('\n\n'))
        if (!parsed) break
        if (parsed.kind === 'skill') {
          s.slashCommands.push(`skill:${parsed.name}`)
          if (!parsed.args) break
          s.prompts.push({
            text: `/skill:${parsed.name} ${parsed.args}`,
            ts,
            source: 'command',
          })
          onText?.({
            source: 'slash-command',
            tool: null,
            ts,
            text: clip(parsed.args),
          })
        } else {
          s.prompts.push({ text: parsed.text, ts, source: 'typed' })
          onText?.({
            source: 'typed-prompt',
            tool: null,
            ts,
            text: clip(parsed.text),
          })
        }
        turnMessageIds = []
        s.endedAfterInterrupt = false
        break
      }

      case 'assistant': {
        const id =
          typeof msg.responseId === 'string' && msg.responseId
            ? msg.responseId
            : entryId
        const m = piModel(msg.model) ?? model
        addUsage(id, m, msg.usage)
        turnMessageIds.push(id)
        const content = Array.isArray(msg.content) ? msg.content : []
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            if (onText && block.text) {
              onText({
                source: 'assistant-text',
                tool: null,
                ts,
                text: clip(block.text),
              })
            }
            continue
          }
          if (block?.type !== 'toolCall' || typeof block.name !== 'string')
            continue
          const name = block.name
          const args = block.arguments ?? null
          const callId = String(block.id ?? '')
          const kind = piToolKind(name)
          stepByCallId.set(callId, s.steps.length)
          s.steps.push({
            tool: piToolDisplayName(name),
            kind,
            detail: piToolDetail(name, args),
            isError: false,
            messageId: id,
            toolUseId: callId,
            ts,
          })
          const key = stepKey(s.steps[s.steps.length - 1]!)
          const command = kind === 'shell' ? piShellCommand(args) : null
          if (command !== null) {
            bashByCallId.set(callId, s.bashRuns.length)
            s.bashRuns.push({
              normalized: normalizeCommand(command),
              messageId: id,
              isError: false,
            })
          }
          if (onText) {
            const text = command ?? stringValues(args)
            if (text)
              onText({ source: 'tool-input', tool: key, ts, text: clip(text) })
          }
        }
        if (msg.stopReason === 'aborted') {
          s.interrupts++
          s.endedAfterInterrupt = true
          s.interruptedTurnMessageIds = [...turnMessageIds]
        } else {
          s.endedAfterInterrupt = false
        }
        break
      }

      case 'toolResult': {
        const callId = String(msg.toolCallId ?? '')
        const si = stepByCallId.get(callId)
        if (msg.isError === true) {
          s.errors++
          if (si !== undefined) s.steps[si]!.isError = true
          const bi = bashByCallId.get(callId)
          if (bi !== undefined) s.bashRuns[bi]!.isError = true
        }
        if (onText) {
          const text = textBlocks(msg.content).join('\n')
          if (text) {
            onText({
              source: 'tool-output',
              tool: si === undefined ? null : stepKey(s.steps[si]!),
              ts,
              text: clip(text),
            })
          }
        }
        // Nested model work a tool did (pi-codemode and the like).
        if (msg.usage) addUsage(entryId, model, msg.usage)
        break
      }

      case 'bashExecution': {
        // A command the user ran with `!`, not an agent step; scanned only.
        if (!onText) break
        if (typeof msg.command === 'string' && msg.command)
          onText({
            source: 'tool-input',
            tool: null,
            ts,
            text: clip(msg.command),
          })
        if (typeof msg.output === 'string' && msg.output)
          onText({
            source: 'tool-output',
            tool: null,
            ts,
            text: clip(msg.output),
          })
        break
      }

      default:
        // system (prompt and AGENTS.md), custom (extension context) and the
        // summary roles carry nothing a person typed.
        break
    }
  }

  s.models = [...models].sort()
  return finishSession(s)
}
