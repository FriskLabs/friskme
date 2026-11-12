import { type Cache, labelKey } from '../cache.ts'
import type { WorkCategory } from '../constants.ts'
import { runPool } from './pool.ts'
import {
  LABEL_SCHEMA,
  type LabelItem,
  labelPrompt,
  labelValidator,
  PROMPT_VERSION,
} from './prompts.ts'
import type { ModelRunner } from './runner.ts'

export const LABEL_BATCH_SIZE = 30

export type SessionLabel = {
  intent: string
  category: WorkCategory
  summary: string
}

export type LabelPassResult = {
  labels: Map<string, SessionLabel>
  unlabeled: string[]
  cached: number
  calls: number
}

export type LabelJob = { sessionId: string; card: string }

/** Which jobs still need a model call; the rest are cache hits. */
export function planLabels(
  jobs: LabelJob[],
  cache: Cache,
  model: string,
): { hits: Map<string, SessionLabel>; todo: LabelJob[] } {
  const hits = new Map<string, SessionLabel>()
  const todo: LabelJob[] = []
  for (const j of jobs) {
    const hit = cache.get<SessionLabel>(
      'labels',
      labelKey(j.sessionId, j.card, model, PROMPT_VERSION),
    )
    if (hit) hits.set(j.sessionId, hit)
    else todo.push(j)
  }
  return { hits, todo }
}

export function batchCount(n: number): number {
  return Math.ceil(n / LABEL_BATCH_SIZE)
}

/**
 * The map pass. Batches of up to 30 cards; a batch's whole response is retried
 * once by the runner. Ids a valid response still left out are re-sent once as
 * one smaller batch, and whatever fails then is reported as unlabeled.
 */
export async function runLabelPass(opts: {
  jobs: LabelJob[]
  runner: ModelRunner
  cache: Cache
  model: string
  concurrency: number
  onProgress?: (done: number, total: number) => void
  /** Called before ids the first pass missed are re-sent; returns their progress callback. */
  onRetry?: (
    sessions: number,
  ) => ((done: number, total: number) => void) | undefined
}): Promise<LabelPassResult> {
  const { hits, todo } = planLabels(opts.jobs, opts.cache, opts.model)
  const labels = new Map(hits)
  const batches: LabelJob[][] = []
  for (let i = 0; i < todo.length; i += LABEL_BATCH_SIZE) {
    batches.push(todo.slice(i, i + LABEL_BATCH_SIZE))
  }
  const before = opts.runner.calls

  const runBatch = async (batch: LabelJob[]): Promise<LabelJob[]> => {
    const ids = batch.map((_, i) => `s${i + 1}`)
    const cards = batch.map((j, i) => `[${ids[i]}] ${j.card}`)
    const out = await opts.runner.run(
      labelPrompt(cards),
      LABEL_SCHEMA,
      labelValidator(ids),
    )
    if (!out.ok) return batch
    const byId = new Map<string, LabelItem>(
      out.value.items.map((it) => [it.id, it]),
    )
    const failed: LabelJob[] = []
    batch.forEach((job, i) => {
      const item = byId.get(ids[i]!)
      if (!item) {
        failed.push(job)
        return
      }
      const label: SessionLabel = {
        intent: item.intent,
        category: item.category,
        summary: item.summary,
      }
      labels.set(job.sessionId, label)
      opts.cache.set(
        'labels',
        labelKey(job.sessionId, job.card, opts.model, PROMPT_VERSION),
        label,
      )
    })
    return failed
  }

  const failedFirst = (
    await runPool(batches, opts.concurrency, runBatch, opts.onProgress)
  ).flat()
  let unlabeled: LabelJob[] = []
  if (failedFirst.length > 0) {
    const retryBatches: LabelJob[][] = []
    // Smaller batches for the retry: whatever made the first attempt fail is
    // more likely to pass with less in one prompt.
    const size = Math.max(5, Math.ceil(LABEL_BATCH_SIZE / 3))
    for (let i = 0; i < failedFirst.length; i += size)
      retryBatches.push(failedFirst.slice(i, i + size))
    unlabeled = (
      await runPool(
        retryBatches,
        opts.concurrency,
        runBatch,
        opts.onRetry?.(failedFirst.length),
      )
    ).flat()
  }
  return {
    labels,
    unlabeled: unlabeled.map((j) => j.sessionId),
    cached: hits.size,
    calls: opts.runner.calls - before,
  }
}
