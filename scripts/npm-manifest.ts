/**
 * The package.json files for the npm release: one `friskme` launcher package,
 * plus one `friskme-<os>-<arch>` package per target holding the binary. npm
 * installs only the platform package whose os/cpu/libc match the machine.
 */
import type { Target } from './targets.ts'

export const NPM_NAME = 'friskme'

export interface RootInfo {
  version: string
  license: string
  description: string
}

const REPOSITORY = {
  type: 'git',
  url: 'git+https://github.com/FriskLabs/frisk-cli.git',
}

export function platformPackageName(t: Target): string {
  return `${NPM_NAME}-${t.id}`
}

export function launcherManifest(
  info: RootInfo,
  targets: readonly Target[],
): Record<string, unknown> {
  return {
    name: NPM_NAME,
    version: info.version,
    description: info.description,
    license: info.license,
    repository: REPOSITORY,
    homepage: 'https://github.com/FriskLabs/frisk-cli#readme',
    type: 'module',
    // `friskme` makes `npx friskme` work; `frisk` is the command after a
    // global install.
    bin: { frisk: 'bin/frisk.js', friskme: 'bin/frisk.js' },
    files: ['bin/frisk.js', 'README.md', 'LICENSE'],
    engines: { node: '>=18' },
    optionalDependencies: Object.fromEntries(
      targets.map((t) => [platformPackageName(t), info.version]),
    ),
  }
}

export function platformManifest(
  info: RootInfo,
  t: Target,
): Record<string, unknown> {
  return {
    name: platformPackageName(t),
    version: info.version,
    description: `The ${t.os}-${t.cpu} binary for ${NPM_NAME}. Install ${NPM_NAME} instead.`,
    license: info.license,
    repository: REPOSITORY,
    os: [t.os],
    cpu: [t.cpu],
    // Bun's Linux builds link against glibc, so musl (Alpine) can't run them.
    ...(t.os === 'linux' ? { libc: ['glibc'] } : {}),
    files: ['bin/frisk', 'LICENSE'],
    preferUnplugged: true,
  }
}
