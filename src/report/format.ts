/**
 * A partial share must never print as 100% (or 0%). Precision is raised until
 * the printed value stops lying, falling back to "<0.01%" / ">99.99%".
 */
export function formatShare(n: number, digits = 1): string {
  const v = n * 100
  if (n > 0 && n < 1) {
    for (let p = digits; p <= 4; p++) {
      const fixed = v.toFixed(p)
      const rounded = Number(fixed)
      if (rounded > 0 && rounded < 100) return `${fixed}%`
    }
    return v < 50 ? '<0.01%' : '>99.99%'
  }
  return `${v.toFixed(digits)}%`
}

/** `$0.0042`, `$1.27`, `$1,204` — enough precision that small items are not $0.00. */
export function formatUsd(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toPrecision(2)}`
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

export function formatDate(iso: string): string {
  return iso.slice(0, 10)
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'intent'
  )
}
