/** Oldest Node frisk runs on: `node:zlib` zstd (compressed Codex rollouts) arrived in 22.15. */
export const MIN_NODE = [22, 15] as const

/** An error message when this runtime is too old, else null. Bun always passes. */
export function runtimeProblem(
  versions: NodeJS.ProcessVersions = process.versions,
): string | null {
  if (versions.bun) return null
  const [major = 0, minor = 0] = versions.node.split('.').map(Number)
  const [minMajor, minMinor] = MIN_NODE
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return null
  return `friskme needs Node ${minMajor}.${minMinor} or newer; this is Node ${versions.node}.`
}
