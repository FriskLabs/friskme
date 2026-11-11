import type { TokenTotals } from '../types.ts'

/**
 * List prices, USD per million tokens. Bundled and dated rather than fetched:
 * frisk makes no network calls of its own.
 *
 * Anthropic (Claude Code): cache writes are 1.25× input (5-minute TTL) and 2×
 * input (1-hour TTL); cache reads vary by model. Haiku 5.5 has a higher tier
 * above 100K prompt tokens ($0.50 / $2.50); the base tier is used throughout,
 * which understates very long Haiku prompts.
 *
 * OpenAI (Codex): standard tier, short context (≤272K input). Inputs above
 * 272K cost more on gpt-5.4 and later; the short-context rate is used
 * throughout, which understates very long prompts. Only gpt-5.6 models list
 * a cache-write rate (30-minute); other models have no write premium, so any
 * write is priced as input. The `-codex` models OpenAI no longer lists are
 * priced as the base model they shipped alongside.
 */
export const RATES_AS_OF = '2026-11-03'
export const OPENAI_RATES_AS_OF = '2026-11-11'

export type Rate = {
  input: number
  output: number
  cacheRead: number
  /** Short-TTL cache write; default 1.25× input (Anthropic 5-minute). */
  cacheWrite5m?: number
  /** Long-TTL cache write; default 2× input (Anthropic 1-hour). */
  cacheWrite1h?: number
}

const ANTHROPIC_RATES: Record<string, Rate> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
}

/** No write premium: a cache write costs what the input would have. */
const openai = (input: number, cacheRead: number, output: number): Rate => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input,
  cacheWrite1h: input,
})

const OPENAI_RATES: Record<string, Rate> = {
  'gpt-5.6-sol': { ...openai(4, 0.4, 20), cacheWrite5m: 5, cacheWrite1h: 10 },
  'gpt-5.6-terra': {
    ...openai(2, 0.2, 12),
    cacheWrite5m: 2.5,
    cacheWrite1h: 5,
  },
  'gpt-5.6-luna': {
    ...openai(0.2, 0.02, 1.2),
    cacheWrite5m: 0.25,
    cacheWrite1h: 0.5,
  },
  'gpt-5.5': openai(5, 0.5, 30),
  'gpt-5.4': openai(2.5, 0.25, 15),
  'gpt-5.4-mini': openai(0.75, 0.075, 4.5),
  'gpt-5.3-codex': openai(1.75, 0.175, 14),
  'gpt-5.2': openai(1.75, 0.175, 14),
  'gpt-5.2-codex': openai(1.75, 0.175, 14),
  'gpt-5.1': openai(1.25, 0.125, 10),
  'gpt-5.1-codex': openai(1.25, 0.125, 10),
  'gpt-5.1-codex-max': openai(1.25, 0.125, 10),
  'gpt-5': openai(1.25, 0.125, 10),
  'gpt-5-codex': openai(1.25, 0.125, 10),
  'gpt-5-mini': openai(0.25, 0.025, 2),
  'gpt-5.1-codex-mini': openai(0.25, 0.025, 2),
  'gpt-5-nano': openai(0.05, 0.005, 0.4),
}

const RATES: Record<string, Rate> = { ...ANTHROPIC_RATES, ...OPENAI_RATES }

/**
 * Resolves a transcript model id to a rate. Accepts date-suffixed ids
 * (`claude-opus-4-6-20260101`, `gpt-5-2025-08-07`) and context suffixes
 * (`[1m]`) by stripping them; anything else unknown returns `null` and is
 * reported as unpriced.
 */
export function rateFor(model: string): Rate | null {
  const base = model
    .replace(/\[.*\]$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
  return RATES[base] ?? null
}

/** Dollars for a token bundle, or `null` when the model has no rate. */
export function priceTokens(model: string, t: TokenTotals): number | null {
  const r = rateFor(model)
  if (!r) return null
  return (
    (t.input * r.input +
      t.output * r.output +
      t.cacheWrite5m * (r.cacheWrite5m ?? r.input * 1.25) +
      t.cacheWrite1h * (r.cacheWrite1h ?? r.input * 2) +
      t.cacheRead * r.cacheRead) /
    1_000_000
  )
}

export const PRICE_BASIS = `API list-price equivalent (Anthropic rates as of ${RATES_AS_OF}, OpenAI rates as of ${OPENAI_RATES_AS_OF})`
