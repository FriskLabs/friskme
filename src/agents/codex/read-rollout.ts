import { readFile } from 'node:fs/promises'
// A namespace import: on a Node without zstd this still loads, and bin.ts
// prints the version requirement instead of a link error.
import * as zlib from 'node:zlib'
import { type JsonlLine, readJsonl } from '../../parse/read-jsonl.ts'

/**
 * Streams a Codex rollout. Codex writes `.jsonl`, and newer builds compress it
 * to `.jsonl.zst`; that is decompressed in memory (`node:zlib` has zstd from Node 22.15).
 */
export async function* readRollout(path: string): AsyncGenerator<JsonlLine> {
  if (!path.endsWith('.zst')) {
    yield* readJsonl(path)
    return
  }
  let text: string
  try {
    const bytes = zlib.zstdDecompressSync(await readFile(path))
    text = new TextDecoder().decode(bytes)
  } catch {
    yield { ok: false }
    return
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
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

/** The `session_meta` payload, which is the first line of every rollout. */
export async function readSessionMeta(path: string): Promise<any | null> {
  for await (const line of readRollout(path)) {
    if (!line.ok || line.fastType !== undefined) return null
    return line.value?.type === 'session_meta'
      ? (line.value.payload ?? null)
      : null
  }
  return null
}
