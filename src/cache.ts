import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRISK_CACHE_DIR || join(homedir(), '.frisk', 'cache')
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Content-addressed JSON cache. Holds only scrubbed cards' hashes and model
 * outputs, never raw transcript text. Writes go to a temp file and are renamed
 * so a crash never leaves a half-written entry.
 */
export class Cache {
  hits = 0
  misses = 0
  constructor(readonly root: string) {}

  private path(kind: string, key: string): string {
    return join(this.root, kind, `${key}.json`)
  }

  get<T>(kind: string, key: string): T | undefined {
    try {
      const v = JSON.parse(readFileSync(this.path(kind, key), 'utf8')) as T
      this.hits++
      return v
    } catch {
      this.misses++
      return undefined
    }
  }

  set(kind: string, key: string, value: unknown): void {
    const target = this.path(kind, key)
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value))
    renameSync(tmp, target)
  }

  clear(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}

/** Label cache key: session id plus a hash of what the model saw and how. */
export function labelKey(
  sessionId: string,
  card: string,
  model: string,
  promptVersion: string,
): string {
  return `${sessionId}.${sha256(`${promptVersion}\n${model}\n${card}`).slice(0, 16)}`
}
