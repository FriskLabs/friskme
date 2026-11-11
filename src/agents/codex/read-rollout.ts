import { type JsonlLine, readJsonl } from '../../parse/read-jsonl.ts'

/**
 * Streams a Codex rollout. Codex writes `.jsonl`, and newer builds compress it
 * to `.jsonl.zst`; that is decompressed in memory (Bun has zstd built in).
 */
export async function* readRollout(path: string): AsyncGenerator<JsonlLine> {
  if (!path.endsWith('.zst')) {
    yield* readJsonl(path)
    return
  }
  let text: string
  try {
    const bytes = Bun.zstdDecompressSync(
      new Uint8Array(await Bun.file(path).arrayBuffer()),
    )
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
