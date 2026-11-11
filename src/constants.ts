export const FRISK_VERSION = '0.1.0'

/**
 * First line of every prompt frisk sends to `claude -p`. A session whose first
 * prompt starts with it was made by frisk, and the parser drops it, so frisk
 * never labels its own calls even if one is ever persisted.
 */
export const FRISK_SENTINEL = '[frisk-cli:v1]'

/** Placeholder until the public page exists. */
export const FRISKAI_URL = 'https://friskai.com'

export const WORK_CATEGORIES = [
  'build feature',
  'fix bug',
  'refactor',
  'write tests',
  'debug/investigate',
  'review code',
  'understand codebase',
  'devops/infra',
  'data/query',
  'docs/writing',
  'other',
] as const

export type WorkCategory = (typeof WORK_CATEGORIES)[number]
