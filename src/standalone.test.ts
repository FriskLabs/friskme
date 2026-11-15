import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * frisk is meant to live in its own repo: no FriskAI workspace packages and no
 * imports reaching outside this app. This keeps one from creeping back in.
 */
const APP = join(import.meta.dir, '..')
const IMPORT =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g

describe('standalone', () => {
  const files = [...new Bun.Glob('{src,scripts}/**/*.ts').scanSync(APP)]

  test('no workspace packages and no imports outside the app', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(join(APP, file), 'utf8')
      for (const m of text.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? ''
        if (spec.startsWith('@friskai/') || spec.startsWith('workspace:'))
          offenders.push(`${file}: ${spec}`)
        if (spec.startsWith('.')) {
          const resolved = join(APP, file, '..', spec)
          if (!resolved.startsWith(APP)) offenders.push(`${file}: ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  // The npm package is a Node bundle: runtime code uses Node APIs only.
  // Tests and build scripts may use Bun.
  test('no Bun-only APIs in runtime code', () => {
    const offenders = files
      .filter((f) => f.startsWith('src') && !f.endsWith('.test.ts'))
      .filter((f) =>
        /\bBun\.|from ['"]bun['"]|import\.meta\.(main|dir|file|path)\b/.test(
          readFileSync(join(APP, f), 'utf8'),
        ),
      )
    expect(offenders).toEqual([])
  })

  test('package.json declares no workspace dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'))
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    }
    expect(
      Object.entries(deps).filter(
        ([name, v]) =>
          name.startsWith('@friskai/') || String(v).startsWith('workspace:'),
      ),
    ).toEqual([])
  })

  // Install-time scripts run on every `bun install`, in CI and on
  // contributors' machines, so the repo has none.
  test('no lifecycle scripts in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'))
    const lifecycle = Object.keys(pkg.scripts ?? {}).filter((name) =>
      /^(pre|post)?(install|prepare|prepublish|prepublishOnly|prepack|postpack|uninstall)$/.test(
        name,
      ),
    )
    expect(lifecycle).toEqual([])
  })
})
