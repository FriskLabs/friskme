import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

export type ResolvedProject = { root: string; label: string }

/** Folder layouts that hold git worktrees, matched on the path alone. */
const NESTED_WORKTREE = /^(.+?)[\\/]\.(?:claude[\\/])?worktrees[\\/][^\\/]+/
const SUPERPOWERS_WORKTREE =
  /^(.*[\\/]superpowers[\\/]worktrees[\\/][^\\/]+)[\\/]/

/** `gitdir: <main>/.git/worktrees/<name>` (or `<bare>.git/worktrees/<name>`). */
const WORKTREE_GITDIR = /^(.+)[\\/]worktrees[\\/][^\\/]+[\\/]?$/

const cache = new Map<string, ResolvedProject>()

/**
 * Maps a session's working directory to the repo it belongs to, so the
 * sessions in a repo's git worktrees count under that repo. Reads at most one
 * small file (`<cwd>/.git`) and never writes.
 */
export function resolveProject(cwd: string): ResolvedProject {
  let hit = cache.get(cwd)
  if (!hit) {
    const root = fromGitFile(cwd) ?? fromLayout(cwd) ?? cwd
    hit = { root, label: labelOf(root) }
    cache.set(cwd, hit)
  }
  return hit
}

/** A linked worktree has a `.git` file pointing into the main repo's `.git/worktrees/`. */
function fromGitFile(cwd: string): string | null {
  let text: string
  try {
    text = readFileSync(resolve(cwd, '.git'), 'utf8')
  } catch {
    return null // missing, a directory (a normal repo) or unreadable
  }
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1]
  if (!gitdir) return null
  const m = WORKTREE_GITDIR.exec(resolve(cwd, gitdir))
  if (!m) return null // e.g. a submodule (`.git/modules/...`)
  const gitDir = m[1]!
  return /[\\/]\.git$/.test(gitDir) ? gitDir.slice(0, -5) : gitDir
}

function fromLayout(cwd: string): string | null {
  return (
    NESTED_WORKTREE.exec(cwd)?.[1] ??
    SUPERPOWERS_WORKTREE.exec(cwd)?.[1] ??
    null
  )
}

function labelOf(root: string): string {
  const name = basename(root) || root
  return name.endsWith('.git') && name.length > 4 ? name.slice(0, -4) : name
}
