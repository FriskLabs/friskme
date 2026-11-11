import type { TokenTotals } from '../types.ts'

/**
 * Anthropic first-party API list prices, USD per million tokens. Bundled and
 * dated rather than fetched: frisk makes no network calls of its own.
 * Cache writes are 1.25× input (5-minute TTL) and 2× input (1-hour TTL);
 * cache reads vary by model. Source: Anthropic pricing as of the date below.
 *
 * Haiku 5.5 has a higher tier above 100K prompt tokens ($0.50 / $2.50); the
 * base tier is used throughout, which understates very long Haiku prompts.
 */
export const RATES_AS_OF = '2026-11-03'

export type Rate = { input: number; output: number; cacheRead: number }

const RATES: Record<string, Rate> = {
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

/**
 * Resolves a transcript model id to a rate. Accepts date-suffixed ids
 * (`claude-opus-4-6-20260101`) and context suffixes (`[1m]`) by stripping
 * them; anything else unknown returns `null` and is reported as unpriced.
 */
export function rateFor(model: string): Rate | null {
  const base = model.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')
  return RATES[base] ?? null
}

/** Dollars for a token bundle, or `null` when the model has no rate. */
export function priceTokens(model: string, t: TokenTotals): number | null {
  const r = rateFor(model)
  if (!r) return null
  return (
    (t.input * r.input +
      t.output * r.output +
      t.cacheWrite5m * r.input * 1.25 +
      t.cacheWrite1h * r.input * 2 +
      t.cacheRead * r.cacheRead) /
    1_000_000
  )
}

export const PRICE_BASIS = `API list-price equivalent (rates as of ${RATES_AS_OF})`
