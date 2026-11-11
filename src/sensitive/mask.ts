import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Detection } from './types.ts'

const DOT = '•'

/**
 * A preview that identifies a value to its owner without revealing it:
 * a secret keeps its first 4 characters and its length, an email keeps one
 * letter of each part, a card its last 4 digits, a name its initials.
 */
export function maskValue(
  d: Pick<Detection, 'kind' | 'type' | 'value'>,
): string {
  const v = d.value
  if (d.type === 'email') {
    const [local = '', domain = ''] = v.split('@')
    const dot = domain.lastIndexOf('.')
    const host = dot > 0 ? domain.slice(0, dot) : domain
    const tld = dot > 0 ? domain.slice(dot) : ''
    return `${local.slice(0, 1)}${DOT.repeat(3)}@${host.slice(0, 1)}${DOT.repeat(3)}${tld}`
  }
  if (d.type === 'credit-card')
    return `${DOT.repeat(4)} ${v.replace(/\D/g, '').slice(-4)}`
  if (d.type === 'us-ssn')
    return `${DOT.repeat(3)}-${DOT.repeat(2)}-${v.slice(-4)}`
  if (d.type === 'iban') return `${v.slice(0, 2)}${DOT.repeat(4)}${v.slice(-4)}`
  if (d.type === 'phone')
    return `${DOT.repeat(4)}${v.replace(/\D/g, '').slice(-2)}`
  if (d.type === 'ip-address') return `${v.split('.')[0]}.${DOT}.${DOT}.${DOT}`
  if (d.type === 'person' || d.type === 'location') {
    return v
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `${w[0]?.toUpperCase()}.`)
      .join(' ')
  }
  // Secrets and anything else: a recognizable prefix and the length.
  const prefix = v.length > 12 ? v.slice(0, 4) : v.slice(0, 1)
  return `${prefix}…(${v.length})`
}

/** Per-install salt, so short values (names, SSNs) cannot be rainbow-tabled from report.json. */
export function loadSalt(path = join(homedir(), '.frisk', 'salt')): Buffer {
  try {
    if (existsSync(path))
      return Buffer.from(readFileSync(path, 'utf8').trim(), 'hex')
    const salt = randomBytes(32)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, salt.toString('hex'), { mode: 0o600 })
    return salt
  } catch {
    // A read-only home still works; fingerprints just don't match across runs.
    return randomBytes(32)
  }
}

export function fingerprint(value: string, salt: Buffer): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 16)
}
