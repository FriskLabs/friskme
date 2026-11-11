import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Cache } from './cache.ts'
import { buildCard } from './card/build-card.ts'
import type { ScrubCounts } from './card/scrub-secrets.ts'
import { FRISK_VERSION } from './constants.ts'
import { loadSessions } from './discover.ts'
import { ClaudeRunner, type SpawnFn } from './llm/claude-runner.ts'
import { runGroupPass } from './llm/group-pass.ts'
import {
  batchCount,
  planLabels,
  runLabelPass,
  type SessionLabel,
} from './llm/label-pass.ts'
import { progressBar, runPool } from './llm/pool.ts'
import { preflight } from './llm/preflight.ts'
import { type GroupedIntent, SYSTEM_PROMPT } from './llm/prompts.ts'
import { draftSkill, findWorkflow } from './llm/skill-pass.ts'
import {
  aggregate,
  type Report,
  typicalSequence,
  type WorkflowReport,
} from './report/aggregate.ts'
import { formatDate, slugify } from './report/format.ts'
import { renderHtml } from './report/html.ts'
import { renderSkill, writeSkill } from './report/skill-files.ts'
import { renderTerminal } from './report/terminal.ts'
import type { ModelScope } from './sensitive/collect.ts'
import type { FetchFn, ModelPaths } from './sensitive/model/download.ts'
import type { Platform } from './sensitive/model/manifest.ts'
import type { NerEngine } from './sensitive/model/ner.ts'
import {
  buildSensitiveReport,
  createCollector,
  estimateModelSeconds,
  type ModelPlan,
  nameMasker,
  planModel,
  runModelPass,
} from './sensitive/run.ts'
import type { SensitiveReport } from './sensitive/summary.ts'
import type { Session } from './types.ts'

export const CONCURRENCY = 4

export type ScanOptions = {
  root: string
  cacheDir: string
  sinceMs: number
  sinceLabel: string
  project?: string
  maxSessions?: number
  model: string
  noLlm: boolean
  outDir: string
  json: boolean
  yes: boolean
  /** Rule-based secrets and PII detection (default on). */
  sensitive: boolean
  /** Also run the local NER model for names and places; downloads it once. */
  piiModel: boolean
  piiModelScope: ModelScope
  /** Write raw sensitive values into report.html/json (default: masked). */
  reveal?: boolean
  modelsDir?: string
  salt: Buffer
  /** Test seams. */
  fetch?: FetchFn
  nerEngine?: (paths: ModelPaths) => Promise<NerEngine>
  platform?: Platform | null
  spawn?: SpawnFn
  which?: (bin: string) => string | null
  now?: () => Date
  log?: (line: string) => void
  out?: (text: string) => void
  confirm?: (question: string) => Promise<boolean>
}

async function ttyConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await rl.question(question)
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

export type ScanResult = { exitCode: number; report?: Report }

export async function scan(opts: ScanOptions): Promise<ScanResult> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`))
  const out = opts.out ?? ((t: string) => process.stdout.write(t))
  const now = opts.now ?? (() => new Date())

  let binary: string | null = null
  if (!opts.noLlm) {
    const pf = await preflight({ which: opts.which, spawn: opts.spawn })
    if (!pf.ok) {
      log(pf.message)
      return { exitCode: 2 }
    }
    binary = pf.binary
  }

  const sensitiveOpts = {
    enabled: opts.sensitive,
    piiModel: opts.piiModel,
    modelScope: opts.piiModelScope,
    reveal: opts.reveal,
    modelsDir: opts.modelsDir,
    salt: opts.salt,
    platform: opts.platform,
  }
  let modelPlan: Extract<ModelPlan, { ok: true }> | null = null
  if (opts.piiModel) {
    const plan = planModel(sensitiveOpts)
    if (!plan.ok) {
      log(plan.message)
      return { exitCode: 2 }
    }
    modelPlan = plan
  }
  const collector = createCollector(sensitiveOpts)

  log(`Reading ${opts.root} (read-only)…`)
  const { sessions, stats, filteredByProject } = await loadSessions(opts.root, {
    sinceMs: opts.sinceMs,
    project: opts.project,
    maxSessions: opts.maxSessions,
    textVisitor: collector ? (id) => collector.visitor(id) : undefined,
  })
  if (sessions.length === 0) {
    log(
      `No sessions with a typed prompt since ${opts.sinceLabel}. Checked ${stats.files} files; ${stats.skippedOutsideWindow} were older, ${stats.skippedNoPrompt} had no typed prompt.`,
    )
    return { exitCode: 1 }
  }
  const projects = new Set(sessions.map((s) => s.project)).size
  const from = sessions.reduce(
    (m, s) => (s.start < m ? s.start : m),
    sessions[0]!.start,
  )
  const to = sessions.reduce(
    (m, s) => (s.end > m ? s.end : m),
    sessions[0]!.end,
  )
  log(
    `Found ${sessions.length} sessions across ${projects} projects, ${formatDate(from)} → ${formatDate(to)}. Skipped ${stats.skippedNoPrompt} with no typed prompt, ${stats.skippedOutsideWindow} older than ${opts.sinceLabel}${stats.malformedLines ? `, ${stats.malformedLines} malformed lines` : ''}.`,
  )

  const redactions: ScrubCounts = {}
  const cache = new Cache(opts.cacheDir)
  const cards = new Map<string, string>(
    sessions.map((s) => [s.id, buildCard(s, redactions)]),
  )
  const jobs = sessions.map((s) => ({
    sessionId: s.id,
    card: cards.get(s.id)!,
  }))

  if (collector && modelPlan) {
    const est = estimateModelSeconds(collector, sessions)
    const download =
      modelPlan.downloadBytes > 0
        ? `downloads ${Math.round(modelPlan.downloadBytes / 1e6)} MB once from ${modelPlan.downloads.join(' and ')} into ${opts.modelsDir ?? '~/.frisk/models'} (hash-verified), then `
        : ''
    log(
      `PII model (${opts.piiModelScope} scope): ${download}reads ${(est.chars / 1e6).toFixed(1)}M characters on this machine, about ${Math.max(1, Math.round(est.seconds / 60))} min before cache hits. Nothing is sent anywhere.`,
    )
  }

  const needsConfirm =
    !opts.noLlm || (modelPlan !== null && modelPlan.downloadBytes > 0)
  if (!opts.noLlm) {
    const pending = planLabels(jobs, new Cache(opts.cacheDir), opts.model).todo
      .length
    const labelCalls = batchCount(pending)
    log(
      `Will run about ${labelCalls + 1} claude -p calls with ${opts.model} (${labelCalls} labeling batches for ${pending} new sessions, ${sessions.length - pending} cached; 1 grouping), plus one per repeated workflow found. Calls use your own Claude login and send scrubbed prompt excerpts, never whole transcripts.`,
    )
  }
  if (needsConfirm) {
    if (!opts.yes) {
      if (!opts.confirm && !process.stdin.isTTY) {
        log(
          'Not a terminal, so cannot ask for confirmation. Re-run with --yes, or with --no-llm.',
        )
        return { exitCode: 2 }
      }
      const ok = await (opts.confirm ?? ttyConfirm)('Continue? [y/N] ')
      if (!ok) {
        log('Cancelled. Nothing was sent or downloaded.')
        return { exitCode: 0 }
      }
    }
  }

  let model: SensitiveReport['model'] = null
  if (collector && modelPlan) {
    const mp = await runModelPass({
      collector,
      sessions,
      plan: modelPlan,
      cache,
      salt: opts.salt,
      scope: opts.piiModelScope,
      reveal: opts.reveal,
      fetch: opts.fetch,
      engine: opts.nerEngine,
      progress: (label) => progressBar(label),
      log,
    })
    model = mp.model
    // Names the model found are masked in cards before anything reaches claude -p.
    if (mp.personFingerprints.size > 0) {
      const mask = nameMasker(mp.personFingerprints, opts.salt)
      for (const s of sessions) cards.set(s.id, buildCard(s, redactions, mask))
      for (const j of jobs) j.card = cards.get(j.sessionId)!
    }
  }
  collector?.releaseText()

  mkdirSync(opts.outDir, { recursive: true })
  const runner = binary
    ? new ClaudeRunner({
        binary,
        model: opts.model,
        systemPrompt: SYSTEM_PROMPT,
        spawn: opts.spawn,
      })
    : null
  let labels: Map<string, SessionLabel> | undefined
  let intents: GroupedIntent[] | undefined
  let workflows: WorkflowReport[] = []
  const llm: Report['llm'] = {
    enabled: !opts.noLlm,
    model: opts.noLlm ? null : opts.model,
    calls: 0,
    failedCalls: 0,
    labelsFromCache: 0,
    unlabeledSessions: 0,
    groupingFellBack: false,
    labelsLeftUngrouped: 0,
    skillDraftsFailed: 0,
    costUsd: 0,
    redactions,
  }

  try {
    if (runner) {
      const lp = await runLabelPass({
        jobs,
        runner,
        cache,
        model: opts.model,
        concurrency: CONCURRENCY,
        onProgress: progressBar('labeling sessions'),
      })
      labels = lp.labels
      llm.labelsFromCache = lp.cached
      llm.unlabeledSessions = lp.unlabeled.length

      const counts = new Map<
        string,
        { label: string; count: number; category: string }
      >()
      for (const l of labels.values()) {
        const key = l.intent.toLowerCase()
        const entry = counts.get(key) ?? {
          label: l.intent,
          count: 0,
          category: l.category,
        }
        entry.count++
        counts.set(key, entry)
      }
      log('  grouping labels into intents…')
      const gp = await runGroupPass({
        inputs: [...counts.values()],
        runner,
        cache,
        model: opts.model,
      })
      intents = gp.intents
      llm.groupingFellBack = gp.fellBackToCategories
      llm.labelsLeftUngrouped = gp.unassigned

      workflows = await draftWorkflows({
        sessions,
        labels,
        intents,
        cards,
        runner,
        cache,
        model: opts.model,
        outDir: opts.outDir,
        date: formatDate(now().toISOString()),
        onFail: () => llm.skillDraftsFailed++,
      })
      llm.calls = runner.calls
      llm.failedCalls = runner.failures
      llm.costUsd = runner.costUsd
    } else {
      workflows = structuralWorkflows(sessions)
    }
  } finally {
    runner?.dispose()
  }

  const report = aggregate({
    sessions,
    stats,
    root: opts.root,
    filteredByProject,
    since: opts.sinceLabel,
    generatedAt: now().toISOString(),
    friskVersion: FRISK_VERSION,
    labels,
    intents,
    workflows,
    llm,
    sensitive: buildSensitiveReport({
      collector,
      sessions,
      model,
      reveal: opts.reveal,
    }),
  })
  writeFileSync(
    join(opts.outDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  writeFileSync(join(opts.outDir, 'report.html'), renderHtml(report))
  if (report.sensitive.revealed) {
    // Raw secrets inside: readable by the owner only.
    for (const f of ['report.json', 'report.html'])
      chmodSync(join(opts.outDir, f), 0o600)
  }

  const summary = renderTerminal(report, {
    outDir: opts.outDir,
    color: !opts.json && process.stdout.isTTY === true,
  })
  if (opts.json) {
    out(`${JSON.stringify(report, null, 2)}\n`)
    log(summary)
  } else {
    out(`${summary}\n`)
  }
  return { exitCode: 0, report }
}

async function draftWorkflows(opts: {
  sessions: Session[]
  labels: Map<string, SessionLabel>
  intents: GroupedIntent[]
  cards: Map<string, string>
  runner: ClaudeRunner
  cache: Cache
  model: string
  outDir: string
  date: string
  onFail: () => void
}): Promise<WorkflowReport[]> {
  const intentOf = new Map<string, GroupedIntent>()
  for (const it of opts.intents)
    for (const l of it.labels) intentOf.set(l.toLowerCase(), it)
  const members = new Map<GroupedIntent, Session[]>()
  for (const s of opts.sessions) {
    const l = opts.labels.get(s.id)
    const it = l ? intentOf.get(l.intent.toLowerCase()) : undefined
    if (!it) continue
    members.set(it, [...(members.get(it) ?? []), s])
  }
  const byId = new Map(opts.sessions.map((s) => [s.id, s]))
  const candidates = [...members.entries()]
    .map(([intent, list]) => ({ intent, cluster: findWorkflow(list) }))
    .filter(
      (
        c,
      ): c is {
        intent: GroupedIntent
        cluster: NonNullable<typeof c.cluster>
      } => c.cluster !== null,
    )
    .sort((a, b) => b.cluster.members.length - a.cluster.members.length)

  const results = await runPool(
    candidates,
    CONCURRENCY,
    async ({ intent, cluster }) => {
      const slug = slugify(intent.name)
      const medoid = byId.get(cluster.members[0]!)!
      const cards = cluster.members.slice(0, 5).map((id) => opts.cards.get(id)!)
      const res = await draftSkill({
        intent,
        cards,
        runner: opts.runner,
        cache: opts.cache,
        model: opts.model,
      })
      let skillPath: string | null = null
      if (res.draft) {
        skillPath = writeSkill(
          opts.outDir,
          slug,
          renderSkill(res.draft, {
            intent: intent.name,
            sessions: cluster.members.length,
            date: opts.date,
          }),
        )
      } else {
        opts.onFail()
      }
      return {
        intent: intent.name,
        slug,
        sessions: cluster.members.length,
        meanSimilarity: cluster.meanSimilarity,
        typicalSequence: typicalSequence(medoid),
        skillPath,
        skill: res.draft,
        note: res.draft
          ? null
          : `Skill draft failed: ${res.reason ?? 'unknown error'}`,
        structural: false,
      } satisfies WorkflowReport
    },
    candidates.length > 0 ? progressBar('drafting skills') : undefined,
  )
  return results
}

/** --no-llm: recurring tool-sequence shapes across all sessions, no names. */
export function structuralWorkflows(
  sessions: Session[],
  limit = 5,
): WorkflowReport[] {
  const out: WorkflowReport[] = []
  let remaining = sessions
  while (out.length < limit) {
    const cluster = findWorkflow(
      remaining.map((s) => ({ id: s.id, steps: s.steps })),
    )
    if (!cluster) break
    const medoid = remaining.find((s) => s.id === cluster.members[0])!
    out.push({
      intent: `Structural pattern ${out.length + 1}`,
      slug: `structural-pattern-${out.length + 1}`,
      sessions: cluster.members.length,
      meanSimilarity: cluster.meanSimilarity,
      typicalSequence: typicalSequence(medoid),
      skillPath: null,
      skill: null,
      note: 'Found from tool sequences alone (--no-llm), so it has no name and no draft skill.',
      structural: true,
    })
    const taken = new Set(cluster.members)
    remaining = remaining.filter((s) => !taken.has(s.id))
  }
  return out
}
