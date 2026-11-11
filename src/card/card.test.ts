import { describe, expect, test } from 'bun:test'
import { fakeSecrets } from '../sensitive/test-secrets.ts'
import type { Session, ToolStep } from '../types.ts'
import { buildCard, foldSequence, truncate } from './build-card.ts'
import { type ScrubCounts, scrubSecrets } from './scrub-secrets.ts'

const fake = fakeSecrets()

describe('scrubSecrets', () => {
  const cases: [string, string][] = [
    ['anthropic-key', fake.anthropic],
    ['openai-project-key', fake.openaiProject],
    ['github-pat', fake.githubPat],
    ['github-fine-grained-pat', fake.githubFineGrained],
    ['slack-bot-token', fake.slackBot],
    ['aws-access-key', fake.awsAccessKey],
    ['gcp-api-key', fake.googleApi],
    ['stripe-key', fake.stripeLive],
    ['jwt', fake.jwt],
    ['linear-key', fake.linear],
  ]
  for (const [kind, secret] of cases) {
    test(`redacts ${kind}`, () => {
      const counts: ScrubCounts = {}
      const out = scrubSecrets(`before ${secret} after`, counts)
      expect(out).toBe(`before [REDACTED:${kind}] after`)
      expect(counts[kind]).toBe(1)
    })
  }

  test('redacts PEM private keys', () => {
    expect(scrubSecrets(`a ${fake.privateKey} b`)).toBe(
      'a [REDACTED:private-key] b',
    )
  })

  test('redacts personal data the detectors find', () => {
    const counts: ScrubCounts = {}
    const out = scrubSecrets('ping jane.doe@acme-corp.io about it', counts)
    expect(out).toBe('ping [REDACTED:email] about it')
    expect(counts.email).toBe(1)
  })

  test('keeps the context around bearer tokens, URL credentials and aws secrets', () => {
    expect(
      scrubSecrets(
        `Authorization: Bearer ${fake.urlPassword}.${fake.urlPassword}`,
      ),
    ).toBe('Authorization: Bearer [REDACTED:bearer-token]')
    expect(
      scrubSecrets(
        `postgres://admin:${fake.urlPassword}@db.prod-host.io:5432/app`,
      ),
    ).toBe(
      'postgres://admin:[REDACTED:url-credentials]@db.prod-host.io:5432/app',
    )
    expect(scrubSecrets(`aws_secret_access_key = ${fake.awsSecretKey}`)).toBe(
      'aws_secret_access_key = [REDACTED:aws-secret-key]',
    )
  })

  test('redacts .env-style secret lines, keeps the name', () => {
    const env =
      'DATABASE_URL=postgres://localhost/app\nSTRIPE_SECRET=abc123\nexport API_TOKEN="xyz"\nDB_PASSWORD=p@ss'
    expect(scrubSecrets(env)).toBe(
      'DATABASE_URL=postgres://localhost/app\nSTRIPE_SECRET=[REDACTED:env-secret]\nexport API_TOKEN=[REDACTED:env-secret]\nDB_PASSWORD=[REDACTED:env-secret]',
    )
  })

  test('redacts long mixed-case tokens nobody named', () => {
    expect(scrubSecrets(`use ${fake.highEntropy} now`)).toBe(
      'use [REDACTED:high-entropy] now',
    )
  })

  test('leaves ordinary text alone', () => {
    const text = [
      'Fix the monkey patch in src/components/UserCardContainerWrapper.tsx',
      'session 3f2b6c1e-8d4a-4e9b-9c7d-1a2b3c4d5e6f and commit 9fceb02d0ae598e95dc970b74767f19372d61af8',
      'The password: field should be required',
      'tokenize the input, then call getApiKey()',
      'connect to postgres://postgres:postgres@localhost:5432/dev',
    ].join('\n')
    expect(scrubSecrets(text)).toBe(text)
  })
})

const step = (
  tool: string,
  detail: string | null,
  isError = false,
): ToolStep => ({
  tool,
  detail,
  isError,
  messageId: 'm',
  toolUseId: 't',
  ts: '',
})

describe('foldSequence', () => {
  test('folds consecutive repeats the same way the product does', () => {
    const steps = [
      step('Read', 'ts'),
      step('Read', 'ts'),
      step('Read', 'ts'),
      step('Edit', 'ts'),
      step('Bash', 'package_manager'),
      step('Edit', 'ts'),
      step('Bash', 'package_manager'),
      step('Bash', 'git'),
    ]
    expect(foldSequence(steps)).toBe(
      'Read:ts ×3 → [Edit:ts → Bash:package_manager] ×2 → Bash:git',
    )
  })

  test('caps very long sequences', () => {
    const steps = Array.from({ length: 200 }, (_, i) => step(`Tool${i}`, null))
    const out = foldSequence(steps, 100)
    expect(out.length).toBeLessThan(140)
    expect(out).toMatch(/… \(\d+ more\)$/)
  })

  test('handles no tool calls', () => {
    expect(foldSequence([])).toBe('(no tool calls)')
  })
})

describe('buildCard', () => {
  const session = (prompts: string[]): Session =>
    ({
      id: 'real-session-id',
      projectLabel: 'demo-app',
      prompts: prompts.map((text) => ({ text, ts: '', source: 'typed' })),
      steps: [step('Read', 'ts')],
      errors: 1,
      interrupts: 0,
    }) as unknown as Session

  test('has the first prompt, non-trivial follow-ups and the folded tools, but no session id', () => {
    const card = buildCard(
      session([
        'Fix login',
        'yes',
        'Also add a test for the expired token case',
        'ok',
      ]),
    )
    expect(card).toContain('First prompt: Fix login')
    expect(card).toContain('- Also add a test for the expired token case')
    expect(card).not.toContain('- yes')
    expect(card).toContain('Tools: Read:ts')
    expect(card).not.toContain('real-session-id')
  })

  test('truncates prompts and caps follow-ups at five', () => {
    const long = 'word '.repeat(400)
    const card = buildCard(
      session([
        long,
        ...Array.from({ length: 8 }, (_, i) => `follow up number ${i}`),
      ]),
    )
    const first = card.split('\n').find((l) => l.startsWith('First prompt:'))!
    expect(first.length).toBeLessThanOrEqual('First prompt: '.length + 600)
    expect(card.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(5)
  })

  test('scrubs secrets before truncating, and counts them', () => {
    const counts: ScrubCounts = {}
    const card = buildCard(
      session([`${'x '.repeat(290)}${fake.githubPat}`]),
      counts,
    )
    expect(card).not.toContain(fake.githubPat.slice(0, 12))
    expect(counts['github-pat']).toBe(1)
  })

  test('truncate collapses whitespace and marks the cut', () => {
    expect(truncate('a  b\n\nc', 10)).toBe('a b c')
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
  })
})
