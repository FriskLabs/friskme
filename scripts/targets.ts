/**
 * Every platform frisk ships a compiled binary for (GitHub Releases).
 * `compile.ts` builds one per entry. npm ships the plain-JS bundle instead.
 */
export interface Target {
  /** `bun build --compile` target. */
  bun: Bun.Build.CompileTarget
  /** Platform suffix: binary `dist/frisk-<id>`. */
  id: string
}

export const TARGETS: readonly Target[] = [
  {
    bun: 'bun-darwin-arm64',
    id: 'darwin-arm64',
  },
  {
    bun: 'bun-darwin-x64',
    id: 'darwin-x64',
  },
  // Baseline: runs on x64 CPUs without AVX2 (older hardware, some cloud VMs).
  {
    bun: 'bun-linux-x64-baseline',
    id: 'linux-x64',
  },
  {
    bun: 'bun-linux-arm64',
    id: 'linux-arm64',
  },
]
