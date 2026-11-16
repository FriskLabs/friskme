/**
 * Collapses an ordered run of steps into individual items and repeated
 * groups, to detect exact consecutive repeats in an ordered sequence.
 *
 * Long agent paths are overwhelmingly repetitive — a 50-step path typically
 * cycles fewer than 10 distinct tools — so folding exact consecutive repeats
 * turns a 50-row wall into a handful of readable items.
 *
 * Only *exact* consecutive repeats fold. Fuzzy matching is deliberately absent:
 * approximating the structure would misrepresent what the agent actually did.
 *
 * Tie-breaking rule: among candidate pattern lengths, the one that folds the
 * MOST steps wins; an equal-coverage tie keeps the SHORTER pattern (lengths
 * are scanned ascending, so the first length to reach the best coverage
 * stands). Returning the first length that merely qualifies looks equivalent
 * but is not: for `AAABAAAB` (a motif whose own body repeats — `grep grep
 * grep edit_file`, looped) length 1 matches the leading `AAA` and would win
 * by arriving first, so the true 4-step motif is never tried and the
 * sequence fragments into four items instead of one. Comparing coverage
 * across all lengths fixes that, and the shorter-wins tie-break keeps `AAAA`
 * reading as `A ×4` rather than `[A→A] ×2`.
 *
 * The reference prototype's `compressPath` (docs/prototype/public/app.js:301)
 * instead breaks ties toward the first length that merely qualifies,
 * scanning ascending — the bug described above. That divergence was
 * deliberate (CON-591): this fold applies the fix everywhere, so the
 * prototype is the one now considered wrong.
 */

export type CompressedStep<T> = {
  kind: 'step'
  /** 0-based position in the original array. */
  index: number
  step: T
}

export type CompressedGroup<T> = {
  kind: 'group'
  /** 0-based, inclusive. */
  startIndex: number
  /** 0-based, inclusive. */
  endIndex: number
  /** The repeating unit, e.g. [read_file, grep]. */
  pattern: T[]
  repeatCount: number
  /** The full expansion the group stands in for. */
  steps: T[]
}

export type CompressedItem<T> = CompressedStep<T> | CompressedGroup<T>

/** Longest repeating unit we look for. Beyond ~4 the fold stops aiding reading. */
export const MAX_MOTIF_LENGTH = 4

/**
 * Minimum steps a group must cover to be worth folding. A `×2` fold of a single
 * tool costs more visual weight as a group row than it saves as two plain rows.
 */
export const MIN_GROUP_STEPS = 3

function windowsMatch<T>(
  steps: T[],
  a: number,
  b: number,
  length: number,
  key: (step: T) => string,
): boolean {
  for (let k = 0; k < length; k++) {
    if (key(steps[a + k]!) !== key(steps[b + k]!)) return false
  }
  return true
}

function findGroupAt<T>(
  steps: T[],
  start: number,
  key: (step: T) => string,
): CompressedGroup<T> | null {
  const remaining = steps.length - start
  const maxPattern = Math.min(MAX_MOTIF_LENGTH, Math.floor(remaining / 2))

  let best: { length: number; repeatCount: number } | null = null

  for (let length = 1; length <= maxPattern; length++) {
    let repeatCount = 1
    while (
      start + (repeatCount + 1) * length <= steps.length &&
      windowsMatch(steps, start, start + repeatCount * length, length, key)
    ) {
      repeatCount++
    }

    if (repeatCount < 2 || length * repeatCount < MIN_GROUP_STEPS) continue

    // Strictly greater, so an equal-coverage tie leaves the shorter pattern in
    // place (lengths are visited ascending).
    if (!best || length * repeatCount > best.length * best.repeatCount) {
      best = { length, repeatCount }
    }
  }

  if (!best) return null

  const endIndex = start + best.length * best.repeatCount - 1
  return {
    kind: 'group',
    startIndex: start,
    endIndex,
    pattern: steps.slice(start, start + best.length),
    repeatCount: best.repeatCount,
    steps: steps.slice(start, endIndex + 1),
  }
}

/**
 * The fold. Callers supply their own key selector rather than reimplementing
 * the scan.
 */
export function compressSteps<T>(
  steps: T[],
  key: (step: T) => string,
): CompressedItem<T>[] {
  const items: CompressedItem<T>[] = []
  let i = 0

  while (i < steps.length) {
    const group = findGroupAt(steps, i, key)
    if (group) {
      items.push(group)
      i = group.endIndex + 1
      continue
    }
    items.push({ kind: 'step', index: i, step: steps[i]! })
    i++
  }

  return items
}
