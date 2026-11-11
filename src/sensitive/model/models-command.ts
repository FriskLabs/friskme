import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { createStatus } from '../../progress.ts'
import {
  downloadPlan,
  ensureModel,
  modelPaths,
  modelsRoot,
  sha256File,
} from './download.ts'
import {
  currentPlatform,
  MODEL_FILES,
  MODEL_NAME,
  MODEL_REVISION,
  ORT_VERSION,
  RUNTIME_BINDINGS,
  RUNTIME_LIBS,
} from './manifest.ts'

function dirSize(path: string): number {
  if (!existsSync(path)) return 0
  const st = statSync(path)
  if (!st.isDirectory()) return st.size
  return readdirSync(path).reduce((n, e) => n + dirSize(join(path, e)), 0)
}

const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`

/** `frisk models list | download | remove`. */
export async function modelsCommand(
  sub: string | undefined,
  opts: { yes: boolean },
): Promise<number> {
  const root = modelsRoot()
  const platform = currentPlatform()
  const say = (s: string) => process.stdout.write(`${s}\n`)
  if (sub === 'remove') {
    rmSync(root, { recursive: true, force: true })
    say(`Deleted ${root}`)
    return 0
  }
  if (!platform) {
    process.stderr.write(
      `The PII model is not available on ${process.platform}-${process.arch}.\n`,
    )
    return 2
  }
  const paths = modelPaths(root, platform)
  if (sub === 'list' || sub === undefined) {
    const plan = downloadPlan(paths, platform)
    say(
      `${MODEL_NAME} @ ${MODEL_REVISION.slice(0, 12)} (onnxruntime ${ORT_VERSION}, ${platform})`,
    )
    say(`  location  ${root}`)
    say(`  on disk   ${mb(dirSize(root))}`)
    if (plan.bytes === 0) {
      // Full hash check on request: catches a file corrupted after download.
      const bad: string[] = []
      for (const f of MODEL_FILES) {
        if ((await sha256File(join(paths.modelDir, f.path))) !== f.sha256)
          bad.push(f.path)
      }
      for (const [path, f] of [
        [paths.runtimeLib, RUNTIME_LIBS[platform]],
        [paths.runtimeBinding, RUNTIME_BINDINGS[platform]],
      ] as const) {
        if ((await sha256File(path)) !== f.sha256) bad.push(f.fileName)
      }
      say(
        bad.length === 0
          ? '  status    installed, all hashes verified'
          : `  status    corrupt: ${bad.join(', ')} (run friskme models remove, then download)`,
      )
    } else {
      say(`  status    not installed (${mb(plan.bytes)} to download)`)
    }
    return 0
  }
  if (sub === 'download') {
    const plan = downloadPlan(paths, platform)
    if (plan.bytes === 0) {
      say('Already installed.')
      return 0
    }
    say(
      `Downloading ${mb(plan.bytes)} from ${[...new Set(plan.items.map((i) => new URL(i.url).host))].join(' and ')} into ${root}.`,
    )
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        process.stderr.write('Not a terminal; re-run with --yes to confirm.\n')
        return 2
      }
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      })
      const answer = await rl.question('Continue? [y/N] ')
      rl.close()
      if (!/^y(es)?$/i.test(answer.trim())) return 0
    }
    const status = createStatus()
    try {
      await ensureModel(paths, platform, {
        progress: (label) =>
          status.bar(`Downloading ${label}`, { format: mb, unit: '' }),
      })
    } finally {
      status.done()
    }
    say('Installed and verified.')
    return 0
  }
  process.stderr.write('Usage: friskme models list|download|remove\n')
  return 2
}
