import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export type JsonlLine =
  | { ok: true; value: any; fastType?: undefined }
  | { ok: true; value: null; fastType: string }
  | { ok: false }

/**
 * Lines whose type alone is enough: they are large (full request payloads)
 * and never used, so they are counted without being parsed. Each starts with
 * its `type` key, which is what makes the prefix check safe.
 */
const SKIP_PREFIXES: [string, string][] = [
  ['{"type":"api-request-blob"', 'api-request-blob'],
  ['{"type":"api-request-shape"', 'api-request-shape'],
  ['{"type":"api-request"', 'api-request'],
  ['{"type":"file-history-snapshot"', 'file-history-snapshot'],
  ['{"type":"file-history-delta"', 'file-history-delta'],
]

/** Streams a JSONL file line by line. Blank lines are skipped silently. */
export async function* readJsonl(path: string): AsyncGenerator<JsonlLine> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  for await (const raw of rl) {
    const line = raw.trim()
    if (line.length === 0) continue
    const skip = SKIP_PREFIXES.find(([prefix]) => line.startsWith(prefix))
    if (skip) {
      yield { ok: true, value: null, fastType: skip[1] }
      continue
    }
    try {
      const value = JSON.parse(line)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        yield { ok: false }
      } else {
        yield { ok: true, value }
      }
    } catch {
      yield { ok: false }
    }
  }
}
