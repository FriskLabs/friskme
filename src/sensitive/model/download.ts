import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  MODEL_FILES,
  MODEL_NAME,
  MODEL_REPO,
  MODEL_REVISION,
  ORT_VERSION,
  type PinnedFile,
  type Platform,
  RUNTIME_BINDINGS,
  RUNTIME_LIBS,
  RUNTIME_TARBALL,
  type RuntimeLib,
} from './manifest.ts'

export function modelsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRISK_MODELS_DIR || join(homedir(), '.frisk', 'models')
}

export type ModelPaths = {
  /** transformers.js `localModelPath`: holds `<repo>/…`. */
  modelRoot: string
  modelDir: string
  runtimeDir: string
  runtimeLib: string
  runtimeBinding: string
}

export function modelPaths(root: string, platform: Platform): ModelPaths {
  const modelRoot = join(root, `${MODEL_NAME}@${MODEL_REVISION.slice(0, 12)}`)
  const runtimeDir = join(root, `onnxruntime-${ORT_VERSION}`, platform)
  return {
    modelRoot,
    modelDir: join(modelRoot, MODEL_REPO),
    runtimeDir,
    runtimeLib: join(runtimeDir, RUNTIME_LIBS[platform].fileName),
    runtimeBinding: join(runtimeDir, RUNTIME_BINDINGS[platform].fileName),
  }
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** Files that are missing or do not match their pinned size; hashes are checked on download. */
export function missingFiles(
  paths: ModelPaths,
  platform: Platform,
): { model: PinnedFile[]; runtime: boolean } {
  const model = MODEL_FILES.filter((f) => {
    const p = join(paths.modelDir, f.path)
    return !existsSync(p) || statSync(p).size !== f.size
  })
  const wrongSize = (p: string, f: RuntimeLib) =>
    !existsSync(p) || statSync(p).size !== f.size
  const runtime =
    wrongSize(paths.runtimeLib, RUNTIME_LIBS[platform]) ||
    wrongSize(paths.runtimeBinding, RUNTIME_BINDINGS[platform])
  return { model, runtime }
}

export function downloadPlan(paths: ModelPaths, platform: Platform) {
  const missing = missingFiles(paths, platform)
  const items = [
    ...missing.model.map((f) => ({ url: f.url, size: f.size })),
    ...(missing.runtime
      ? [{ url: RUNTIME_TARBALL.url, size: RUNTIME_TARBALL.size }]
      : []),
  ]
  return { items, bytes: items.reduce((n, i) => n + i.size, 0), missing }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>
export type Progress = (done: number, total: number) => void

/**
 * Streams `url` to `dest`, resuming a `.part` file with a Range request, then
 * verifies size and SHA-256 before renaming into place. On a mismatch the
 * file is deleted and this throws.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expect: { size: number; sha256: string },
  opts: { fetch?: FetchFn; onProgress?: Progress } = {},
): Promise<void> {
  const doFetch = opts.fetch ?? fetch
  const part = `${dest}.part`
  mkdirSync(dirname(dest), { recursive: true })
  let offset = existsSync(part) ? statSync(part).size : 0
  if (offset > expect.size) {
    rmSync(part)
    offset = 0
  }
  if (offset < expect.size) {
    const res = await doFetch(
      url,
      offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : undefined,
    )
    if (!res.ok || !res.body)
      throw new Error(`Download failed (${res.status}) for ${url}`)
    // A server that ignores Range sends the whole file: start over.
    if (offset > 0 && res.status !== 206) {
      rmSync(part, { force: true })
      offset = 0
    }
    const sink = createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' })
    let done = offset
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!sink.write(chunk))
        await new Promise<void>((r) => sink.once('drain', () => r()))
      done += chunk.byteLength
      opts.onProgress?.(done, expect.size)
    }
    await new Promise<void>((resolve, reject) =>
      sink.end((err?: Error | null) => (err ? reject(err) : resolve())),
    )
  }
  const size = statSync(part).size
  const hash = await sha256File(part)
  if (size !== expect.size || hash !== expect.sha256) {
    rmSync(part, { force: true })
    throw new Error(
      `Checksum mismatch for ${url}: expected ${expect.size} bytes ${expect.sha256.slice(0, 12)}…, got ${size} bytes ${hash.slice(0, 12)}…. The file was deleted.`,
    )
  }
  renameSync(part, dest)
}

/** Reads one regular file out of a gzipped tar (ustar, with PAX long names). */
export function extractFromTarGz(tgz: Buffer, wanted: string): Buffer | null {
  const tar = gunzipSync(tgz)
  let offset = 0
  let paxPath: string | null = null
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const field = (start: number, len: number) =>
      header
        .subarray(start, start + len)
        .toString('utf8')
        .replace(/\0.*$/s, '')
    const size = Number.parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    const prefix = field(345, 155)
    const name =
      paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    const bodyStart = offset + 512
    const body = tar.subarray(bodyStart, bodyStart + size)
    paxPath = null
    if (type === 'x') {
      const m = /\d+ path=([^\n]+)\n/.exec(body.toString('utf8'))
      paxPath = m?.[1] ?? null
    } else if ((type === '0' || type === '') && name === wanted) {
      return Buffer.from(body)
    }
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  return null
}

/** Downloads whatever is missing. Every file is checked against its pinned hash. */
export async function ensureModel(
  paths: ModelPaths,
  platform: Platform,
  opts: { fetch?: FetchFn; progress?: (label: string) => Progress } = {},
): Promise<void> {
  const { missing } = downloadPlan(paths, platform)
  for (const f of missing.model) {
    await downloadVerified(f.url, join(paths.modelDir, f.path), f, {
      fetch: opts.fetch,
      onProgress: opts.progress?.(f.path),
    })
  }
  if (missing.runtime) {
    const tgzPath = join(
      paths.runtimeDir,
      `onnxruntime-node-${ORT_VERSION}.tgz`,
    )
    await downloadVerified(RUNTIME_TARBALL.url, tgzPath, RUNTIME_TARBALL, {
      fetch: opts.fetch,
      onProgress: opts.progress?.('onnxruntime'),
    })
    const tgz = await readFile(tgzPath)
    rmSync(tgzPath, { force: true })
    const files: [RuntimeLib, string][] = [
      [RUNTIME_LIBS[platform], paths.runtimeLib],
      [RUNTIME_BINDINGS[platform], paths.runtimeBinding],
    ]
    // Check both before installing either.
    const extracted = files.map(([f, dest]) => {
      const bytes = extractFromTarGz(tgz, f.tarPath)
      if (!bytes)
        throw new Error(`${f.tarPath} was not in the runtime package.`)
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (hash !== f.sha256)
        throw new Error(
          `Checksum mismatch for ${f.fileName}; nothing was installed.`,
        )
      return { bytes, dest }
    })
    for (const { bytes, dest } of extracted) {
      await writeFile(`${dest}.part`, bytes)
      renameSync(`${dest}.part`, dest)
    }
  }
}
