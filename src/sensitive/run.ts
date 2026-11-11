import type { Cache } from '../cache.ts'
import type { Session } from '../types.ts'
import { type ModelScope, SensitiveCollector } from './collect.ts'
import {
  downloadPlan,
  ensureModel,
  type FetchFn,
  type ModelPaths,
  modelPaths,
  modelsRoot,
} from './model/download.ts'
import {
  currentPlatform,
  MODEL_NAME,
  MODEL_REVISION,
  type Platform,
} from './model/manifest.ts'
import {
  ESTIMATED_TOKENS_PER_SECOND,
  MODEL_DETECTOR,
  maskKnownNames,
  type NerEngine,
  runNer,
  startWorker,
} from './model/ner.ts'
import {
  RULES_VERSION,
  type SensitiveReport,
  summarizeSensitive,
} from './summary.ts'

export type SensitiveOptions = {
  enabled: boolean
  piiModel: boolean
  modelScope: ModelScope
  /** Put raw values in the report (--reveal). */
  reveal?: boolean
  modelsDir?: string
  salt: Buffer
  /** Test seams. */
  fetch?: FetchFn
  engine?: (paths: ModelPaths) => Promise<NerEngine>
  platform?: Platform | null
}

export type ModelPlan =
  | {
      ok: true
      platform: Platform
      paths: ModelPaths
      downloadBytes: number
      downloads: string[]
    }
  | { ok: false; message: string }

export function planModel(opts: SensitiveOptions): ModelPlan {
  const platform =
    opts.platform === undefined ? currentPlatform() : opts.platform
  if (!platform) {
    return {
      ok: false,
      message: `--pii-model runs on macOS (arm64, x64) and Linux x64; this is ${process.platform}-${process.arch}. Run without --pii-model for rule-based detection.`,
    }
  }
  const paths = modelPaths(opts.modelsDir ?? modelsRoot(), platform)
  const plan = downloadPlan(paths, platform)
  return {
    ok: true,
    platform,
    paths,
    downloadBytes: plan.bytes,
    downloads: [...new Set(plan.items.map((i) => new URL(i.url).host))],
  }
}

export type SensitiveRun = {
  collector: SensitiveCollector | null
  /** Person fingerprints found by the model, for masking names in cards. */
  personFingerprints: Set<string>
  model: SensitiveReport['model']
}

export function createCollector(
  opts: SensitiveOptions,
): SensitiveCollector | null {
  if (!opts.enabled) return null
  return new SensitiveCollector(opts.salt, {
    rules: true,
    modelScope: opts.piiModel ? opts.modelScope : null,
    reveal: opts.reveal === true,
  })
}

/** Downloads (if needed, already confirmed) and runs the model over the in-scope text of kept sessions. */
export async function runModelPass(opts: {
  collector: SensitiveCollector
  sessions: Session[]
  plan: Extract<ModelPlan, { ok: true }>
  cache: Cache
  salt: Buffer
  scope: ModelScope
  reveal?: boolean
  fetch?: FetchFn
  engine?: (paths: ModelPaths) => Promise<NerEngine>
  progress?: (label: string) => (done: number, total: number) => void
  log: (line: string) => void
}): Promise<{
  model: NonNullable<SensitiveReport['model']>
  personFingerprints: Set<string>
}> {
  if (opts.plan.downloadBytes > 0) {
    await ensureModel(opts.plan.paths, opts.plan.platform, {
      fetch: opts.fetch,
      progress: opts.progress,
    })
    opts.log(`  model files verified in ${opts.plan.paths.modelRoot}`)
  }
  const kept = new Set(opts.sessions.map((s) => s.id))
  const segments = opts.collector.modelSegments.filter((s) =>
    kept.has(s.sessionId),
  )
  const personFingerprints = new Set<string>()
  const result = await runNer({
    texts: segments.map((s) => s.text),
    engine: () => (opts.engine ?? startWorker)(opts.plan.paths),
    cache: opts.cache,
    salt: opts.salt,
    reveal: opts.reveal,
    emit: (i, e, value) => {
      const seg = segments[i]!
      if (e.type === 'person') personFingerprints.add(e.fingerprint)
      opts.collector.addMasked(seg.sessionId, seg, {
        kind: 'pii',
        type: e.type,
        confidence: e.confidence,
        detector: MODEL_DETECTOR,
        masked: e.masked,
        fingerprint: e.fingerprint,
        value,
      })
    },
    onProgress: opts.progress?.('scanning for names'),
  })
  return {
    model: {
      name: MODEL_NAME,
      revision: MODEL_REVISION,
      scope: opts.scope,
      chars: result.chars,
      chunks: result.chunks,
      cachedChunks: result.cachedChunks,
      seconds: Math.round(result.seconds * 10) / 10,
    },
    personFingerprints,
  }
}

/** Seconds the model is expected to take over the in-scope text of these sessions. */
export function estimateModelSeconds(
  collector: SensitiveCollector,
  sessions: Session[],
): { chars: number; seconds: number } {
  const kept = new Set(sessions.map((s) => s.id))
  const chars = collector.modelSegments
    .filter((s) => kept.has(s.sessionId))
    .reduce((n, s) => n + s.text.length, 0)
  return { chars, seconds: chars / 4 / ESTIMATED_TOKENS_PER_SECOND }
}

export function nameMasker(
  fps: Set<string>,
  salt: Buffer,
): (text: string) => string {
  return (text) => maskKnownNames(text, fps, salt)
}

export function buildSensitiveReport(opts: {
  collector: SensitiveCollector | null
  sessions: Session[]
  model: SensitiveReport['model']
  reveal?: boolean
}): SensitiveReport {
  if (!opts.collector) {
    return {
      enabled: false,
      revealed: false,
      rulesVersion: RULES_VERSION,
      scannedChars: 0,
      segments: 0,
      model: null,
      totals: {
        secrets: 0,
        secretValues: 0,
        pii: 0,
        piiValues: 0,
        sessions: 0,
        lowConfidence: 0,
      },
      summary: [],
      values: [],
      findings: [],
    }
  }
  const projectOf = new Map(opts.sessions.map((s) => [s.id, s.projectLabel]))
  return {
    enabled: true,
    revealed: opts.reveal === true,
    rulesVersion: RULES_VERSION,
    scannedChars: opts.collector.chars,
    segments: opts.collector.segments,
    model: opts.model,
    ...summarizeSensitive(opts.collector.findings(projectOf)),
  }
}
