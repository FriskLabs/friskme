import { readdir, stat } from 'node:fs/promises'

/** Directory entries, or none when the directory is missing or unreadable. */
export async function listDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

export async function statOrNull(path: string) {
  return stat(path).catch(() => null)
}
