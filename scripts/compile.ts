/**
 * Builds single-file `frisk` executables (no Bun needed to run them).
 * The binaries are attached to GitHub Releases; npm ships the plain-JS bundle
 * (bundle.ts). `sharp` is stubbed (see sharp-stub.ts). The ONNX Runtime
 * binding, its library and the PII model are downloaded on first use of
 * --pii-model, never bundled (see ort-binding-stub.cjs).
 *
 *   bun scripts/compile.ts          # this machine's platform only
 *   bun scripts/compile.ts --all    # every supported platform (release)
 */
import { rmSync } from 'node:fs'
import { BUILD_PLUGINS } from './build-plugins.ts'
import { TARGETS } from './targets.ts'

const host = `${process.platform}-${process.arch}`
const all = process.argv.includes('--all')
const selected = TARGETS.filter((t) => all || t.id === host)
if (selected.length === 0) {
  console.error(`No supported target for ${host}; use --all to cross-compile.`)
  process.exit(1)
}

for (const { id } of selected) rmSync(`dist/frisk-${id}`, { force: true })
for (const { bun: target, id } of selected) {
  const name = `frisk-${id}`
  const result = await Bun.build({
    entrypoints: ['src/bin.ts'],
    minify: true,
    compile: { target, outfile: `dist/${name}` },
    plugins: BUILD_PLUGINS,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(String(log))
    process.exit(1)
  }
  console.log(`compiled dist/${name}`)
}
