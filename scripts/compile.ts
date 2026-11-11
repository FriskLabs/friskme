/**
 * Builds single-file `frisk` executables (no Bun needed to run them).
 * Workspace packages are bundled in. `sharp` is stubbed (see sharp-stub.ts).
 * The ONNX Runtime binding (~0.3 MB) is embedded; its runtime library and the
 * PII model are downloaded on first use of --pii-model, never bundled.
 *
 *   bun scripts/compile.ts          # this machine's platform only
 *   bun scripts/compile.ts --all    # every supported platform (release)
 */
import { rmSync } from 'node:fs'

const TARGETS = [
  ['bun-darwin-arm64', 'frisk-darwin-arm64'],
  ['bun-darwin-x64', 'frisk-darwin-x64'],
  ['bun-linux-x64', 'frisk-linux-x64'],
] as const

const host = `bun-${process.platform}-${process.arch}`
const all = process.argv.includes('--all')
const selected = TARGETS.filter(([target]) => all || target === host)
if (selected.length === 0) {
  console.error(`No supported target for ${host}; use --all to cross-compile.`)
  process.exit(1)
}

rmSync('dist', { recursive: true, force: true })
for (const [target, name] of selected) {
  const result = await Bun.build({
    entrypoints: ['src/cli.ts'],
    minify: true,
    compile: { target, outfile: `dist/${name}` },
    plugins: [
      {
        name: 'stub-sharp',
        setup(build) {
          build.onResolve({ filter: /^sharp$/ }, () => ({
            path: `${import.meta.dir}/sharp-stub.ts`,
          }))
        },
      },
    ],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(String(log))
    process.exit(1)
  }
  console.log(`compiled dist/${name}`)
}
