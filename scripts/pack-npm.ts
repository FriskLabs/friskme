/**
 * Lays out the npm package from the bundle in dist/.
 *
 *   bun run build:npm
 *   bun scripts/pack-npm.ts 0.1.0   # writes dist/npm/friskme/
 *
 * The version must match package.json and FRISK_VERSION, so `frisk --version`
 * always agrees with the published package.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { FRISK_VERSION } from '../src/constants.ts'
import { BUNDLE } from './bundle-path.ts'
import { NPM_NAME, packageManifest, type RootInfo } from './npm-manifest.ts'

const root = join(import.meta.dir, '..')
const pkg = (await Bun.file(join(root, 'package.json')).json()) as {
  version: string
  license?: string
  description?: string
}

function die(message: string): never {
  console.error(message)
  process.exit(1)
}

const version = process.argv[2]
if (!version) die('usage: bun scripts/pack-npm.ts <version>')
if (version !== pkg.version || version !== FRISK_VERSION) {
  die(
    `version ${version} does not match package.json (${pkg.version}) and FRISK_VERSION (${FRISK_VERSION}). Bump both first.`,
  )
}
if (!pkg.license) die('package.json needs a "license" field.')
if (!existsSync(join(root, 'LICENSE'))) die('LICENSE file is missing.')

const info: RootInfo = {
  version,
  license: pkg.license,
  description:
    pkg.description ??
    'A local report on what your coding-agent sessions were actually for.',
}

const out = join(root, 'dist', 'npm')
rmSync(out, { recursive: true, force: true })

async function writePackage(
  dir: string,
  manifest: Record<string, unknown>,
  files: [from: string, to: string, mode?: number][],
) {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  await Bun.write(
    join(dir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  for (const [from, to, mode] of files) {
    copyFileSync(from, join(dir, to))
    if (mode) chmodSync(join(dir, to), mode)
  }
  console.log(`wrote ${dir}`)
}

const bundle = join(root, BUNDLE)
if (!existsSync(bundle)) die(`${bundle} is missing; run build:npm first.`)
await writePackage(join(out, NPM_NAME), packageManifest(info), [
  [bundle, 'bin/frisk.js', 0o755],
  [join(root, 'README.md'), 'README.md'],
  [join(root, 'LICENSE'), 'LICENSE'],
])
