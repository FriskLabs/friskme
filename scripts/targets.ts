/**
 * Every platform frisk ships for. `compile.ts` builds one binary per entry,
 * and `npm-manifest.ts` makes one npm package per entry.
 */
export interface Target {
  /** `bun build --compile` target. */
  bun: Bun.Build.CompileTarget
  /** Platform suffix: binary `dist/frisk-<id>`, npm package `friskme-<id>`. */
  id: string
  /** `process.platform` value. */
  os: 'darwin' | 'linux'
  /** `process.arch` value. */
  cpu: 'arm64' | 'x64'
}

export const TARGETS: readonly Target[] = [
  {
    bun: 'bun-darwin-arm64',
    id: 'darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
  },
  {
    bun: 'bun-darwin-x64',
    id: 'darwin-x64',
    os: 'darwin',
    cpu: 'x64',
  },
  // Baseline: runs on x64 CPUs without AVX2 (older hardware, some cloud VMs).
  {
    bun: 'bun-linux-x64-baseline',
    id: 'linux-x64',
    os: 'linux',
    cpu: 'x64',
  },
  {
    bun: 'bun-linux-arm64',
    id: 'linux-arm64',
    os: 'linux',
    cpu: 'arm64',
  },
]
