/**
 * Test-only: realistic-shaped fake secrets, built at runtime from split
 * prefixes and a seeded PRNG. No secret-shaped string appears literally in
 * the repo, so GitHub secret scanning and push protection never fire on
 * frisk's own tests.
 */
function seeded(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'
const ALNUM = UPPER + LOWER + DIGITS

export function fakeSecrets(seed = 7) {
  const rnd = seeded(seed)
  const pick = (alphabet: string, n: number) => {
    let out = ''
    for (let i = 0; i < n; i++)
      out += alphabet[Math.floor(rnd() * alphabet.length)]
    return out
  }
  const j = (...parts: string[]) => parts.join('')
  return {
    awsAccessKey: j('AK', 'IA', pick(`${UPPER}234567`, 16)),
    awsSecretKey: pick(`${ALNUM}/+`, 40),
    githubPat: j('gh', 'p_', pick(ALNUM, 36)),
    githubFineGrained: j('github', '_pat_', pick(`${ALNUM}_`, 82)),
    slackBot: j(
      'xo',
      'xb-',
      pick(DIGITS, 12),
      '-',
      pick(DIGITS, 12),
      '-',
      pick(ALNUM, 24),
    ),
    stripeLive: j('sk', '_live_', pick(ALNUM, 24)),
    anthropic: j('sk-', 'ant-', 'api03-', pick(`${ALNUM}_-`, 93), 'AA'),
    openaiProject: j('sk-', 'proj-', pick(`${ALNUM}_-`, 60)),
    googleApi: j('AI', 'za', pick(`${ALNUM}_-`, 35)),
    linear: j('lin', '_api_', pick(ALNUM, 40)),
    npm: j('np', 'm_', pick(ALNUM, 36)),
    jwt: j(
      'ey',
      'J',
      pick(ALNUM, 20),
      '.',
      'ey',
      'J',
      pick(ALNUM, 30),
      '.',
      pick(`${ALNUM}_-`, 43),
    ),
    privateKey: [
      j('-----BEGIN', ' RSA PRIVATE', ' KEY-----'),
      ...Array.from({ length: 8 }, () => pick(`${ALNUM}+/`, 64)),
      j('-----END', ' RSA PRIVATE', ' KEY-----'),
    ].join('\n'),
    urlPassword: pick(ALNUM, 14),
    highEntropy:
      pick(UPPER, 6) + pick(DIGITS, 4) + pick(LOWER, 8) + pick(ALNUM, 18),
  }
}
