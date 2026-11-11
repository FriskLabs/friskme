/**
 * The package.json for the npm release: one `friskme` package holding the
 * plain-JS bundle (bundle.ts). It runs on Node, so there is nothing
 * per-platform to install.
 */

export const NPM_NAME = 'friskme'
/** `node:zlib` zstd (compressed Codex rollouts) needs 22.15. */
export const NODE_ENGINE = '>=22.15'

export interface RootInfo {
  version: string
  license: string
  description: string
}

export function packageManifest(info: RootInfo): Record<string, unknown> {
  return {
    name: NPM_NAME,
    version: info.version,
    description: info.description,
    license: info.license,
    repository: {
      type: 'git',
      url: 'git+https://github.com/FriskLabs/frisk-cli.git',
    },
    homepage: 'https://github.com/FriskLabs/frisk-cli#readme',
    type: 'module',
    // `friskme` makes `npx friskme` work; `frisk` is the command after a
    // global install.
    bin: { frisk: 'bin/frisk.js', friskme: 'bin/frisk.js' },
    files: ['bin/frisk.js', 'README.md', 'LICENSE'],
    engines: { node: NODE_ENGINE },
  }
}
