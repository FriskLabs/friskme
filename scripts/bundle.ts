/**
 * Builds `dist/frisk.js`: frisk and its dependencies as one ESM file for
 * Node ≥ 22.15. This is what the `friskme` npm package ships.
 *
 *   bun scripts/bundle.ts
 *
 * Fails if the output imports anything but Node built-ins or needs a native
 * addon next to it, so the package never depends on files it doesn't contain.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { BUILD_PLUGINS } from './build-plugins.ts'
import { BUNDLE } from './bundle-path.ts'

rmSync(BUNDLE, { force: true })
const result = await Bun.build({
  entrypoints: ['src/bin.ts'],
  target: 'node',
  format: 'esm',
  minify: true,
  outdir: 'dist',
  naming: 'frisk.js',
  plugins: BUILD_PLUGINS,
})
if (!result.success) {
  for (const log of result.logs) console.error(String(log))
  process.exit(1)
}
const extra = result.outputs.filter((o) => !o.path.endsWith('/frisk.js'))
if (extra.length > 0) {
  console.error(
    `bundle emitted extra files: ${extra.map((o) => o.path).join(', ')}`,
  )
  process.exit(1)
}

// The bundler keeps bin.ts's `#!/usr/bin/env bun` and adds a `// @bun`
// marker; replace both with a Node shebang.
const body = readFileSync(BUNDLE, 'utf8').replace(
  /^(?:#![^\n]*\n|\/\/ @bun[^\n]*\n)+/,
  '',
)
const text = `#!/usr/bin/env node\n${body}`
writeFileSync(BUNDLE, text, { mode: 0o755 })
const specs = new Set<string>()
for (const m of text.matchAll(
  /\bfrom\s*["']([@\w][\w@./:-]*)["']|\bimport\(\s*["']([@\w][\w@./:-]*)["']\s*\)|\brequire\(\s*["']([@\w][\w@./:-]*)["']\s*\)/g,
))
  specs.add(m[1] ?? m[2] ?? m[3] ?? '')
const external = [...specs].filter((s) => !s.startsWith('node:'))
if (external.length > 0) {
  console.error(`bundle imports non-built-in modules: ${external.join(', ')}`)
  process.exit(1)
}
console.log(`bundled ${BUNDLE} (${(text.length / 1e6).toFixed(1)} MB)`)
