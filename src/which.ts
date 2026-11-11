import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Finds an executable on PATH, like `which`. On Windows it also tries each
 * PATHEXT extension (`claude.cmd`, `codex.exe`).
 */
export function which(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  const exts =
    platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
      : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext.toLowerCase())
      if (isExecutable(candidate, platform)) return candidate
    }
  }
  return null
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
