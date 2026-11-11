/** Helpers shared by every agent adapter for building and folding tool steps. */

export function fileExtension(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return 'noext'
  return base.slice(dot + 1).toLowerCase()
}

/** Fold key: tool plus coarse detail. */
export function stepKey(step: { tool: string; detail: string | null }): string {
  return step.detail ? `${step.tool}:${step.detail}` : step.tool
}

export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}
