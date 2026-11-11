import { RULES_VERSION } from './rules/secrets.ts'
import type {
  Confidence,
  SegmentSource,
  SensitiveFinding,
  SensitiveKind,
} from './types.ts'

export type SensitiveSummaryRow = {
  kind: SensitiveKind
  type: string
  confidence: Confidence
  uniqueValues: number
  occurrences: number
  sessions: number
  sources: { source: SegmentSource; count: number }[]
}

/** One distinct value, everywhere it was seen. Identified by its salted fingerprint, never by the value. */
export type SensitiveValue = {
  kind: SensitiveKind
  type: string
  masked: string
  fingerprint: string
  /** The raw value. Present only with --reveal. */
  value?: string
  /** Best confidence seen for this value. */
  confidence: Confidence
  occurrences: number
  sessions: number
  projects: string[]
  sources: { source: SegmentSource; tool: string | null; count: number }[]
  firstSeen: string
  lastSeen: string
  detectors: string[]
  /** One row per session the value appeared in, most recent first. */
  seenIn: {
    sessionId: string
    project: string
    ts: string
    source: SegmentSource
    tool: string | null
    occurrences: number
  }[]
}

export type SensitiveReport = {
  enabled: boolean
  /** True when raw values are in this report (--reveal). */
  revealed: boolean
  rulesVersion: string
  scannedChars: number
  segments: number
  model: null | {
    name: string
    revision: string
    scope: 'prompts' | 'all'
    chars: number
    chunks: number
    cachedChunks: number
    seconds: number
  }
  totals: {
    secrets: number
    secretValues: number
    pii: number
    piiValues: number
    sessions: number
    lowConfidence: number
  }
  summary: SensitiveSummaryRow[]
  /** One entry per distinct value, secrets first. Low confidence is included and flagged. */
  values: SensitiveValue[]
  /** Per-session findings (masked), secrets first. */
  findings: SensitiveFinding[]
}

const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }

/** The best confidence seen for a value wins its row; counts are computed here, in code. */
export function summarizeSensitive(
  findings: SensitiveFinding[],
): Pick<SensitiveReport, 'totals' | 'summary' | 'values' | 'findings'> {
  const groups = new Map<string, SensitiveFinding[]>()
  for (const f of findings) {
    const k = `${f.kind}|${f.type}`
    groups.set(k, [...(groups.get(k) ?? []), f])
  }
  const summary: SensitiveSummaryRow[] = [...groups.values()].map((list) => {
    const sources = new Map<SegmentSource, number>()
    for (const f of list)
      sources.set(f.source, (sources.get(f.source) ?? 0) + f.occurrences)
    return {
      kind: list[0]!.kind,
      type: list[0]!.type,
      confidence: list.reduce<Confidence>(
        (c, f) => (RANK[f.confidence] < RANK[c] ? f.confidence : c),
        'low',
      ),
      uniqueValues: new Set(list.map((f) => f.fingerprint)).size,
      occurrences: list.reduce((n, f) => n + f.occurrences, 0),
      sessions: new Set(list.map((f) => f.sessionId)).size,
      sources: [...sources]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count),
    }
  })
  summary.sort(
    (a, b) =>
      Number(a.kind === 'pii') - Number(b.kind === 'pii') ||
      RANK[a.confidence] - RANK[b.confidence] ||
      b.uniqueValues - a.uniqueValues,
  )
  const sorted = [...findings].sort(
    (a, b) =>
      Number(a.kind === 'pii') - Number(b.kind === 'pii') ||
      RANK[a.confidence] - RANK[b.confidence] ||
      a.type.localeCompare(b.type) ||
      b.occurrences - a.occurrences,
  )
  const shown = findings.filter((f) => f.confidence !== 'low')
  const secrets = shown.filter((f) => f.kind === 'secret')
  const pii = shown.filter((f) => f.kind === 'pii')
  return {
    totals: {
      secrets: secrets.reduce((n, f) => n + f.occurrences, 0),
      secretValues: new Set(secrets.map((f) => f.fingerprint)).size,
      pii: pii.reduce((n, f) => n + f.occurrences, 0),
      piiValues: new Set(pii.map((f) => f.fingerprint)).size,
      sessions: new Set(shown.map((f) => f.sessionId)).size,
      lowConfidence: findings.length - shown.length,
    },
    summary,
    values: groupValues(findings),
    findings: sorted,
  }
}

/** Groups per-session findings into one entry per distinct value (kind, type, fingerprint). */
export function groupValues(findings: SensitiveFinding[]): SensitiveValue[] {
  const groups = new Map<string, SensitiveFinding[]>()
  for (const f of findings) {
    const k = `${f.kind}|${f.type}|${f.fingerprint}`
    const list = groups.get(k)
    if (list) list.push(f)
    else groups.set(k, [f])
  }
  const values = [...groups.values()].map((list): SensitiveValue => {
    const first = list[0]!
    const sources = new Map<
      string,
      { source: SegmentSource; tool: string | null; count: number }
    >()
    for (const f of list) {
      const key = `${f.source}|${f.tool ?? ''}`
      const e = sources.get(key) ?? { source: f.source, tool: f.tool, count: 0 }
      e.count += f.occurrences
      sources.set(key, e)
    }
    const times = list
      .map((f) => f.ts)
      .filter(Boolean)
      .sort()
    return {
      kind: first.kind,
      type: first.type,
      masked: first.masked,
      fingerprint: first.fingerprint,
      ...(list.find((f) => f.value !== undefined)?.value !== undefined
        ? { value: list.find((f) => f.value !== undefined)!.value }
        : {}),
      confidence: list.reduce<Confidence>(
        (c, f) => (RANK[f.confidence] < RANK[c] ? f.confidence : c),
        'low',
      ),
      occurrences: list.reduce((n, f) => n + f.occurrences, 0),
      sessions: new Set(list.map((f) => f.sessionId)).size,
      projects: [...new Set(list.map((f) => f.project))].sort(),
      sources: [...sources.values()].sort((a, b) => b.count - a.count),
      firstSeen: times[0] ?? '',
      lastSeen: times[times.length - 1] ?? '',
      detectors: [...new Set(list.map((f) => f.detector))].sort(),
      seenIn: list
        .map((f) => ({
          sessionId: f.sessionId,
          project: f.project,
          ts: f.ts,
          source: f.source,
          tool: f.tool,
          occurrences: f.occurrences,
        }))
        .sort((a, b) => (a.ts < b.ts ? 1 : -1)),
    }
  })
  return values.sort(
    (a, b) =>
      Number(a.kind === 'pii') - Number(b.kind === 'pii') ||
      RANK[a.confidence] - RANK[b.confidence] ||
      b.sessions - a.sessions ||
      b.occurrences - a.occurrences ||
      a.type.localeCompare(b.type),
  )
}

export { RULES_VERSION }
