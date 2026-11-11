/**
 * Structured PII recognizers. The approach follows Microsoft Presidio's
 * pattern recognizers (https://github.com/microsoft/presidio, MIT License):
 * a pattern, a validator that rejects look-alikes, and context words that
 * raise confidence. Unstructured PII (names, places) needs the optional NER
 * model (`--pii-model`).
 */
import { findNumbers } from 'libphonenumber-js/min'
import type { Confidence, Detection } from '../types.ts'
import {
  base58CheckValid,
  cardNetwork,
  ibanValid,
  luhnValid,
  publicIpv4,
  ssnValid,
  TEST_CARDS,
} from '../validators.ts'

const CONTEXT_WINDOW = 60

function hasContext(text: string, index: number, words: RegExp): boolean {
  return words.test(text.slice(Math.max(0, index - CONTEXT_WINDOW), index))
}

function pii(
  type: string,
  value: string,
  confidence: Confidence,
  detector: string,
): Detection {
  return { kind: 'pii', type, value, confidence, detector: `rule:${detector}` }
}

// ---------- email ----------

const EMAIL =
  /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,24}))(?![A-Za-z0-9-])/g
const NOT_EMAIL_TLDS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'css',
  'scss',
  'json',
  'md',
  'html',
  'map',
  'lock',
  'yaml',
  'yml',
  'toml',
  'txt',
  'wasm',
  'node',
])
const TEST_DOMAINS =
  /(^|\.)(example\.(com|org|net)|test|invalid|localhost|local|example|users\.noreply\.github\.com)$/i
const ROLE_LOCALS =
  /^(no-?reply|noreply|donotreply|do-not-reply|git|postmaster|mailer-daemon|root|admin|support|info|hello|security|abuse)$/i
/** Bot and tooling addresses that appear in commit trailers, not people. */
const SERVICE_ADDRESSES =
  /^(noreply@anthropic\.com|.*\[bot\]@.*|.*@users\.noreply\.github\.com)$/i

function detectEmails(text: string, out: Detection[]): void {
  if (!text.includes('@')) return
  for (const m of text.matchAll(EMAIL)) {
    const [value, local, domain, tld] = m as unknown as [
      string,
      string,
      string,
      string,
    ]
    if (NOT_EMAIL_TLDS.has(tld.toLowerCase())) continue
    // `scheme://user:password@host` is a credential (secrets rules), not an address.
    const tokenStart =
      Math.max(
        text.lastIndexOf(' ', m.index ?? 0),
        text.lastIndexOf('\n', m.index ?? 0),
      ) + 1
    if (text.slice(tokenStart, m.index).includes('://')) continue
    if (
      TEST_DOMAINS.test(domain) ||
      ROLE_LOCALS.test(local) ||
      SERVICE_ADDRESSES.test(value)
    )
      continue
    // npm scopes and decorators (`@types/x`) never match; versions like `pkg@1.2.3` have no alpha TLD.
    out.push(pii('email', value, 'medium', 'email'))
  }
}

// ---------- credit cards ----------

const CARD =
  /(?<![\d.,-])(\d{4}[ -]?\d{4,6}[ -]?\d{4,5}[ -]?\d{0,4}[ -]?\d{0,3})(?![\d.,-])/g
const CARD_CONTEXT =
  /(card|credit|visa|mastercard|amex|cc[-_ ]?num|payment|billing)/i

function detectCards(text: string, out: Detection[]): void {
  for (const m of text.matchAll(CARD)) {
    const raw = m[1]!
    const digits = raw.replace(/[ -]/g, '')
    if (digits.length < 13 || digits.length > 19) continue
    if (/^(\d)\1+$/.test(digits) || TEST_CARDS.has(digits)) continue
    if (!cardNetwork(digits) || !luhnValid(digits)) continue
    const context = hasContext(text, m.index ?? 0, CARD_CONTEXT)
    // An unformatted 16-digit run is usually an id that passes Luhn by chance (1 in 10).
    if (!context && !/\d[ -]\d/.test(raw)) continue
    const conf = context ? 'high' : 'medium'
    out.push(pii('credit-card', digits, conf, 'credit-card'))
  }
}

// ---------- IBAN ----------

const IBAN = /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?)\b/g

function detectIbans(text: string, out: Detection[]): void {
  for (const m of text.matchAll(IBAN)) {
    const compact = m[1]!.replace(/ /g, '')
    if (compact.length < 15 || compact.length > 34 || !ibanValid(compact))
      continue
    out.push(pii('iban', compact, 'high', 'iban'))
  }
}

// ---------- US SSN ----------

const SSN = /(?<![\d-])(\d{3}-\d{2}-\d{4})(?![\d-])/g
const SSN_CONTEXT = /(ssn|social security|social sec|taxpayer|tin\b)/i

function detectSsns(text: string, out: Detection[]): void {
  for (const m of text.matchAll(SSN)) {
    if (!ssnValid(m[1]!)) continue
    // Without context, a dashed 3-2-4 number is too often a date or an id.
    if (!hasContext(text, m.index ?? 0, SSN_CONTEXT)) continue
    out.push(pii('us-ssn', m[1]!, 'high', 'us-ssn'))
  }
}

// ---------- phone ----------

const PHONE_CONTEXT =
  /(phone|tel(?:ephone)?|mobile|cell|call|sms|whatsapp|fax|contact)\b/i
const PHONE_HINT = /(\+\d|phone|tel|mobile|cell|call|sms|whatsapp|fax|contact)/i

function detectPhones(text: string, out: Detection[]): void {
  // Phone parsing is the slowest recognizer; skip text with no hint of a number.
  if (!PHONE_HINT.test(text)) return
  for (const found of findNumbers(text, { defaultCountry: 'US', v2: true })) {
    const raw = text.slice(found.startsAt, found.endsAt)
    const international = raw.trimStart().startsWith('+')
    const context = hasContext(text, found.startsAt, PHONE_CONTEXT)
    if (!international && !context) continue
    // Bare digit runs are ids and counters; a written phone number has separators or a `+`.
    if (!international && !/[-. ()]/.test(raw.trim())) continue
    out.push(
      pii('phone', found.number.number, context ? 'high' : 'medium', 'phone'),
    )
  }
}

// ---------- IP address ----------

const IPV4 = /(?<![\w.])((?:\d{1,3}\.){3}\d{1,3})(?![\w.])/g
const IP_CONTEXT =
  /(ip|host|server|ssh|addr|address|connect|endpoint|instance)/i

function detectIps(text: string, out: Detection[]): void {
  for (const m of text.matchAll(IPV4)) {
    const ip = m[1]!
    if (!publicIpv4(ip)) continue
    // `v1.2.3.4`-style versions.
    const before = text[(m.index ?? 0) - 1]
    if (before === 'v' || before === 'V') continue
    out.push(
      pii(
        'ip-address',
        ip,
        hasContext(text, m.index ?? 0, IP_CONTEXT) ? 'medium' : 'low',
        'ip-address',
      ),
    )
  }
}

// ---------- crypto wallets ----------

const ETH = /(?<![A-Za-z0-9])(0x[a-fA-F0-9]{40})(?![A-Za-z0-9])/g
const BTC_LEGACY =
  /(?<![A-Za-z0-9])([13][a-km-zA-HJ-NP-Z1-9]{25,34})(?![A-Za-z0-9])/g
const BTC_BECH32 =
  /(?<![A-Za-z0-9])(bc1[ac-hj-np-z02-9]{11,71})(?![A-Za-z0-9])/g
const WALLET_CONTEXT =
  /(wallet|address|eth|btc|bitcoin|ethereum|crypto|send|pay)/i

function detectWallets(text: string, out: Detection[]): void {
  if (text.includes('0x')) {
    for (const m of text.matchAll(ETH)) {
      // Contract addresses and hashes in code are common; require context.
      if (!hasContext(text, m.index ?? 0, WALLET_CONTEXT)) continue
      out.push(pii('crypto-wallet', m[1]!, 'medium', 'crypto-wallet'))
    }
  }
  if (text.includes('bc1')) {
    for (const m of text.matchAll(BTC_BECH32))
      out.push(pii('crypto-wallet', m[1]!, 'medium', 'crypto-wallet'))
  }
  for (const m of text.matchAll(BTC_LEGACY)) {
    if (!base58CheckValid(m[1]!)) continue
    out.push(pii('crypto-wallet', m[1]!, 'medium', 'crypto-wallet'))
  }
}

export function detectPii(text: string): Detection[] {
  const out: Detection[] = []
  detectEmails(text, out)
  detectCards(text, out)
  detectIbans(text, out)
  detectSsns(text, out)
  detectPhones(text, out)
  detectIps(text, out)
  detectWallets(text, out)
  return out
}
