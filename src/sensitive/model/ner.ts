import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { type Cache, sha256 } from '../../cache.ts'
import { fingerprint, maskValue } from '../mask.ts'
import type { Confidence } from '../types.ts'
import type { ModelPaths } from './download.ts'
import { MODEL_NAME, MODEL_REVISION } from './manifest.ts'

export const MIN_SCORE = 0.85
/** Bump when entity post-processing changes, so cached fingerprints are recomputed. */
export const NER_CACHE_VERSION = 'ner-2'
export const CHUNK_CHARS = 1000
/** Measured on an Apple M-series laptop with the compiled binary; used only for the estimate. */
export const ESTIMATED_TOKENS_PER_SECOND = 6000

/** One token from transformers.js token classification. */
export type NerToken = {
  entity: string
  score: number
  index: number
  word: string
}
export type RawEntity = {
  type: 'person' | 'location'
  value: string
  score: number
}
/** What is cached and reported: no raw value. */
export type MaskedEntity = {
  type: 'person' | 'location'
  masked: string
  fingerprint: string
  confidence: Confidence
}

/** Merges B-/I- word pieces into entities; `##` pieces join without a space. */
export function aggregateTokens(tokens: NerToken[]): RawEntity[] {
  const out: RawEntity[] = []
  let cur: {
    type: string
    words: string[]
    scores: number[]
    last: number
  } | null = null
  const flush = () => {
    if (!cur) return
    const type =
      cur.type === 'PER' ? 'person' : cur.type === 'LOC' ? 'location' : null
    if (type) {
      // `##` pieces continue a word; punctuation (O'Brien, Jean-Luc) joins
      // without spaces, so the value matches the text it came from.
      const value = cur.words.reduce((s, w) => {
        if (w.startsWith('##')) return s + w.slice(2)
        if (!s) return w
        if (/^[^\p{L}\p{N}]+$/u.test(w) || /[-'’.]$/.test(s)) return s + w
        return `${s} ${w}`
      }, '')
      out.push({
        type,
        value,
        score: cur.scores.reduce((a, b) => a + b, 0) / cur.scores.length,
      })
    }
    cur = null
  }
  for (const t of [...tokens].sort((a, b) => a.index - b.index)) {
    const [bio, label] = t.entity.includes('-')
      ? t.entity.split('-')
      : ['B', t.entity]
    const continues =
      cur &&
      cur.type === label &&
      t.index === cur.last + 1 &&
      (bio === 'I' || t.word.startsWith('##'))
    if (!continues) {
      flush()
      cur = { type: label!, words: [], scores: [], last: t.index }
    }
    cur!.words.push(t.word)
    cur!.scores.push(t.score)
    cur!.last = t.index
  }
  flush()
  return out
}

/** Names the coding assistant and tooling world are full of; not people's PII. */
const NOT_PEOPLE = new Set([
  'claude',
  'claude code',
  'anthropic',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'gpt',
  'copilot',
  'gemini',
  'cursor',
  'codex',
  'next',
  'react',
  'bun',
  'node',
  'prisma',
  'jest',
  'vitest',
  'biome',
  'linear',
])

/**
 * Keeps entities that look like a person's name or a place, not code:
 * score ≥ 0.85, capitalized words only, no camelCase, no acronyms. A person
 * needs two or more words (a first name alone is weak PII and mostly noise).
 * Locations are kept at low confidence (report.json only).
 */
export function acceptEntity(e: RawEntity): Confidence | null {
  if (e.score < MIN_SCORE) return null
  const v = e.value.trim()
  if (v.length < 2 || NOT_PEOPLE.has(v.toLowerCase())) return null
  if (!/^[\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*)*$/u.test(v))
    return null
  if (/\p{Ll}\p{Lu}/u.test(v) || /^\p{Lu}{2,}$/u.test(v)) return null
  if (e.type === 'person') return v.split(/\s+/).length >= 2 ? 'medium' : null
  return 'low'
}

/** Splits text into chunks at whitespace; skips chunks with no capitalized word. */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(text.length, i + size)
    if (end < text.length) {
      const ws = text.lastIndexOf(' ', end)
      if (ws > i + size / 2) end = ws
    }
    const chunk = text.slice(i, end)
    if (/\p{Lu}\p{Ll}/u.test(chunk)) out.push(chunk)
    i = end
  }
  return out
}

/** A running NER worker process: send text, get raw entities back. */
export interface NerEngine {
  detect(text: string): Promise<NerToken[]>
  close(): void
}

/** Spawns `frisk __ner-worker`, pointing the dynamic loader at the downloaded runtime. */
export async function startWorker(paths: ModelPaths): Promise<NerEngine> {
  // Compiled: the binary is the CLI. From source: run cli.ts itself, not
  // Bun.main, which is whatever script started the process (a test, say).
  const compiled =
    import.meta.url.includes('$bunfs') || Bun.main.startsWith('/$bunfs/')
  const cliEntry = new URL('../../cli.ts', import.meta.url).pathname
  const cmd = compiled
    ? [process.execPath, '__ner-worker', paths.modelRoot]
    : [process.execPath, cliEntry, '__ner-worker', paths.modelRoot]
  const proc = Bun.spawn(cmd, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      DYLD_FALLBACK_LIBRARY_PATH: paths.runtimeDir,
      LD_LIBRARY_PATH: paths.runtimeDir,
    },
  })
  const lines = createInterface({
    input: Readable.fromWeb(proc.stdout as unknown as WebReadableStream),
  })
  const pending = new Map<number, (t: NerToken[]) => void>()
  let ready: () => void
  let failed: (e: Error) => void
  const readyP = new Promise<void>((res, rej) => {
    ready = res
    failed = rej
  })
  let nextId = 1
  lines.on('line', (line) => {
    let msg: {
      id?: number
      ready?: boolean
      tokens?: NerToken[]
      error?: string
    }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.ready) ready()
    else if (msg.error && msg.id === undefined) failed(new Error(msg.error))
    else if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg.tokens ?? [])
      pending.delete(msg.id)
    }
  })
  proc.exited.then(async (code) => {
    const err = await new Response(proc.stderr).text().catch(() => '')
    failed(
      new Error(
        `NER worker exited (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`,
      ),
    )
    for (const resolve of pending.values()) resolve([])
  })
  await readyP
  return {
    detect(text) {
      const id = nextId++
      return new Promise((resolve) => {
        pending.set(id, resolve)
        proc.stdin.write(`${JSON.stringify({ id, text })}\n`)
        proc.stdin.flush()
      })
    },
    close() {
      proc.stdin.end()
      proc.kill()
    },
  }
}

/** The worker side: loads the model from disk only (remote loading is off) and answers line by line. */
export async function runNerWorker(modelRoot: string): Promise<void> {
  const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`)
  try {
    const { env, pipeline } = await import('@huggingface/transformers')
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = `${modelRoot}/`
    const ner = await pipeline('token-classification', 'Xenova/bert-base-NER', {
      dtype: 'q8',
      device: 'cpu',
    })
    out({ ready: true })
    const rl = createInterface({ input: process.stdin })
    for await (const line of rl) {
      const { id, text } = JSON.parse(line) as { id: number; text: string }
      try {
        const tokens = (await ner(text, {
          ignore_labels: ['O'],
        })) as unknown as NerToken[]
        out({
          id,
          tokens: tokens.map((t) => ({
            entity: t.entity,
            score: t.score,
            index: t.index,
            word: t.word,
          })),
        })
      } catch {
        out({ id, tokens: [] })
      }
    }
  } catch (err) {
    out({ error: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  }
}

export type NerRunResult = {
  chunks: number
  cachedChunks: number
  chars: number
  seconds: number
}

/**
 * Runs the model over texts, using the per-chunk cache. Calls `emit` with
 * masked entities only; raw values never leave this function.
 */
export async function runNer(opts: {
  texts: string[]
  engine: () => Promise<NerEngine>
  cache: Cache
  salt: Buffer
  /** `value` is passed only when `reveal` is set. */
  emit: (textIndex: number, e: MaskedEntity, value?: string) => void
  onProgress?: (done: number, total: number) => void
  /** --reveal: recover raw values for the report. They are never cached. */
  reveal?: boolean
}): Promise<NerRunResult> {
  const start = performance.now()
  const jobs: { textIndex: number; chunk: string; key: string }[] = []
  let chars = 0
  opts.texts.forEach((t, textIndex) => {
    for (const chunk of chunkText(t)) {
      chars += chunk.length
      jobs.push({
        textIndex,
        chunk,
        key: sha256(`${MODEL_REVISION}\n${NER_CACHE_VERSION}\n${chunk}`),
      })
    }
  })
  let cachedChunks = 0
  let engine: NerEngine | null = null
  try {
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!
      let entities = opts.cache.get<MaskedEntity[]>('pii-ner', job.key)
      const fresh = new Map<string, string>()
      if (entities) cachedChunks++
      else {
        engine ??= await opts.engine()
        const raw = aggregateTokens(await engine.detect(job.chunk))
        entities = []
        for (const e of raw) {
          const confidence = acceptEntity(e)
          if (!confidence) continue
          entities.push({
            type: e.type,
            masked: maskValue({ kind: 'pii', type: e.type, value: e.value }),
            fingerprint: fingerprint(e.value, opts.salt),
            confidence,
          })
          if (opts.reveal) fresh.set(fingerprint(e.value, opts.salt), e.value)
        }
        opts.cache.set('pii-ner', job.key, entities)
      }
      for (const e of entities) {
        const value = opts.reveal
          ? (fresh.get(e.fingerprint) ??
            recoverByFingerprint(job.chunk, e.fingerprint, opts.salt))
          : undefined
        opts.emit(job.textIndex, e, value ?? undefined)
      }
      opts.onProgress?.(i + 1, jobs.length)
    }
  } finally {
    engine?.close()
  }
  return {
    chunks: jobs.length,
    cachedChunks,
    chars,
    seconds: (performance.now() - start) / 1000,
  }
}

/**
 * The span of `text` whose fingerprint is `fp`, for cache hits under
 * --reveal: the cache holds only fingerprints, and the chunk text is at hand.
 */
export function recoverByFingerprint(
  text: string,
  fp: string,
  salt: Buffer,
): string | null {
  for (const m of text.matchAll(
    /\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,3}/gu,
  )) {
    const words = m[0].split(/\s+/)
    for (let len = words.length; len >= 1; len--) {
      for (let i = 0; i + len <= words.length; i++) {
        const span = words.slice(i, i + len)
        const candidate = span.join(' ')
        if (fingerprint(candidate, salt) === fp) return candidate
        // The model can stop mid-word (`Car` of `Carlton`): try the last word's prefixes.
        const last = span[span.length - 1]!
        for (let cut = last.length - 1; cut >= 2; cut--) {
          const partial = [...span.slice(0, -1), last.slice(0, cut)].join(' ')
          // Show the whole word as written; it is what you would search for.
          if (fingerprint(partial, salt) === fp) return candidate
        }
      }
    }
  }
  return null
}

/**
 * Masks known person names in text without holding the names: every
 * capitalized 2–4 word span is fingerprinted and compared.
 */
export function maskKnownNames(
  text: string,
  personFingerprints: Set<string>,
  salt: Buffer,
): string {
  if (personFingerprints.size === 0) return text
  return text.replace(
    /\b\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){1,3}\b/gu,
    (span) => {
      const words = span.split(/\s+/)
      for (let len = words.length; len >= 2; len--) {
        for (let i = 0; i + len <= words.length; i++) {
          const candidate = words.slice(i, i + len).join(' ')
          if (personFingerprints.has(fingerprint(candidate, salt))) {
            return span.replace(candidate, '[name]')
          }
        }
      }
      return span
    },
  )
}

export const MODEL_DETECTOR = `model:${MODEL_NAME}`
