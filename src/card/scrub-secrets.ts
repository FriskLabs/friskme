import { detectInText } from '../sensitive/detect.ts'

/**
 * Redacts secrets and personal data before text is cached or sent to a
 * model. Everything the sensitive-data detectors find (src/sensitive) is
 * redacted, so a value the report flags can never reach `claude -p`. A few
 * broader patterns follow as a safety net: for cards, redacting too much is
 * the right failure.
 */
export type ScrubCounts = Record<string, number>

type Fallback = {
  kind: string
  pattern: RegExp
  replace: (match: string, prefix: string) => string
}

const FALLBACKS: Fallback[] = [
  {
    kind: 'bearer-token',
    pattern: /(\bBearer\s+)(?!\[REDACTED)[A-Za-z0-9._~+/=-]{16,}/g,
    replace: (_m, prefix) => `${prefix}[REDACTED:bearer-token]`,
  },
  {
    kind: 'env-secret',
    pattern:
      /^(\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)(?!\[REDACTED)\S.*$/gm,
    replace: (_m, prefix) => `${prefix}[REDACTED:env-secret]`,
  },
  {
    // Long opaque runs with mixed case and digits: likely a token nobody
    // named. `/` is excluded so file paths do not match.
    kind: 'high-entropy',
    pattern:
      /\b(?=[A-Za-z0-9+_-]*[0-9])(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*[A-Z])[A-Za-z0-9+_-]{32,}={0,2}/g,
    replace: () => '[REDACTED:high-entropy]',
  },
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function scrubSecrets(text: string, counts: ScrubCounts = {}): string {
  let out = text
  // Longest first, so a key inside a longer match is replaced as part of it.
  const found = detectInText(text).sort(
    (a, b) => b.value.length - a.value.length,
  )
  for (const d of found) {
    const kind = d.kind === 'secret' ? d.detector.replace(/^rule:/, '') : d.type
    out = out.replace(new RegExp(escapeRegExp(d.value), 'g'), () => {
      counts[kind] = (counts[kind] ?? 0) + 1
      return `[REDACTED:${kind}]`
    })
  }
  for (const f of FALLBACKS) {
    out = out.replace(f.pattern, (match: string, prefix: unknown) => {
      counts[f.kind] = (counts[f.kind] ?? 0) + 1
      return f.replace(match, typeof prefix === 'string' ? prefix : '')
    })
  }
  return out
}
