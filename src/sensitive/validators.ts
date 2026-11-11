import { createHash } from 'node:crypto'

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

export function luhnValid(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return digits.length > 0 && sum % 10 === 0
}

/** Issuer prefixes and lengths for the major card networks. */
export function cardNetwork(digits: string): string | null {
  const n = digits.length
  const p2 = Number(digits.slice(0, 2))
  const p4 = Number(digits.slice(0, 4))
  if (digits.startsWith('4') && (n === 13 || n === 16 || n === 19))
    return 'visa'
  if (((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) && n === 16)
    return 'mastercard'
  if ((p2 === 34 || p2 === 37) && n === 15) return 'amex'
  if (
    (digits.startsWith('6011') || digits.startsWith('65')) &&
    n >= 16 &&
    n <= 19
  )
    return 'discover'
  if (p4 >= 3528 && p4 <= 3589 && n >= 16 && n <= 19) return 'jcb'
  return null
}

/** Published test card numbers (Stripe, Braintree, Adyen docs). Not PII. */
export const TEST_CARDS = new Set([
  '4242424242424242',
  '4000056655665556',
  '4111111111111111',
  '4012888888881881',
  '4000000000000002',
  '4000000000009995',
  '5555555555554444',
  '5200828282828210',
  '5105105105105100',
  '378282246310005',
  '371449635398431',
  '6011111111111117',
  '6011000990139424',
  '3566002020360505',
])

/** ISO 13616 mod-97 check. Input without spaces. */
export function ibanValid(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0)
    const chunk = code >= 65 ? String(code - 55) : ch
    for (const d of chunk) remainder = (remainder * 10 + Number(d)) % 97
  }
  return remainder === 1
}

/** SSA rules: no 000/666/9xx area, no 00 group, no 0000 serial, no famous examples. */
export function ssnValid(ssn: string): boolean {
  const m = /^(\d{3})-(\d{2})-(\d{4})$/.exec(ssn)
  if (!m) return false
  const [, area, group, serial] = m
  if (area === '000' || area === '666' || area!.startsWith('9')) return false
  if (group === '00' || serial === '0000') return false
  if (ssn === '123-45-6789' || ssn === '078-05-1120') return false
  return true
}

/** Public, routable IPv4 only. */
export function publicIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return false
  }
  const [a, b, c] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  // Documentation ranges (RFC 5737) and benchmarking (RFC 2544).
  if (a === 192 && b === 0 && c === 2) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  return true
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Base58Check (legacy BTC addresses): last 4 bytes are a double-SHA256 checksum. */
export function base58CheckValid(s: string): boolean {
  let n = 0n
  for (const ch of s) {
    const i = BASE58.indexOf(ch)
    if (i < 0) return false
    n = n * 58n + BigInt(i)
  }
  let hex = n.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const leadingZeros = s.match(/^1*/)?.[0].length ?? 0
  const bytes = Buffer.concat([
    Buffer.alloc(leadingZeros),
    Buffer.from(hex, 'hex'),
  ])
  if (bytes.length !== 25) return false
  const body = bytes.subarray(0, 21)
  const check = bytes.subarray(21)
  const h = createHash('sha256')
    .update(createHash('sha256').update(body).digest())
    .digest()
  return h.subarray(0, 4).equals(check)
}

/** Six or more consecutive keyboard or alphabet characters: typed by a person, not generated. */
const SEQUENTIAL_RUN =
  /(abcdef|bcdefg|cdefgh|defghi|efghij|fghijk|ghijkl|hijklm|ijklmn|jklmno|klmnop|lmnopq|mnopqr|nopqrs|opqrst|pqrstu|qrstuv|rstuvw|stuvwx|tuvwxy|uvwxyz|012345|123456|234567|345678|456789|qwerty|asdfgh|zxcvbn)/i

/** Placeholder-looking values are not secrets. */
export function looksLikePlaceholder(v: string): boolean {
  if (SEQUENTIAL_RUN.test(v)) return true
  const s = v.toLowerCase()
  if (/^[x*•.]+$/.test(s) || /^(.)\1+$/.test(s)) return true
  if (/^[<{[$%]/.test(v) || v.includes('${') || v.includes('{{')) return true
  return /(example|placeholder|changeme|your[_-]?|redacted|dummy|sample|xxxx|\*\*\*|test[_-]?(key|token|secret)|fake|<.*>)/.test(
    s,
  )
}
