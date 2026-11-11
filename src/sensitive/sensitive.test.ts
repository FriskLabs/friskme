import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseSessionFile } from '../agents/claude/build-session.ts'
import { claudeSource } from '../agents/claude/index.ts'
import { Cache } from '../cache.ts'
import { loadSessions } from '../discover.ts'
import { emptyCounters, type TextVisit } from '../parse/common.ts'
import { SensitiveCollector } from './collect.ts'
import { detectInText } from './detect.ts'
import { fingerprint, loadSalt, maskValue } from './mask.ts'
import { downloadVerified, extractFromTarGz } from './model/download.ts'
import {
  acceptEntity,
  aggregateTokens,
  chunkText,
  maskKnownNames,
  type NerEngine,
  type NerToken,
  recoverByFingerprint,
  runNer,
} from './model/ner.ts'
import { summarizeSensitive } from './summary.ts'
import { fakeSecrets } from './test-secrets.ts'
import {
  base58CheckValid,
  ibanValid,
  luhnValid,
  publicIpv4,
  shannonEntropy,
  ssnValid,
} from './validators.ts'

const fake = fakeSecrets(11)
const SALT = Buffer.alloc(32, 7)
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frisk-sensitive-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const types = (text: string) =>
  detectInText(text).map((d) => `${d.kind}:${d.detector}`)

describe('secret rules', () => {
  const positives: [string, string][] = [
    ['aws-access-key', `key=${fake.awsAccessKey}`],
    ['aws-secret-key', `aws_secret_access_key = "${fake.awsSecretKey}"`],
    ['github-pat', `token ${fake.githubPat}`],
    ['github-fine-grained-pat', fake.githubFineGrained],
    ['slack-bot-token', fake.slackBot],
    ['stripe-key', fake.stripeLive],
    ['anthropic-key', fake.anthropic],
    ['openai-project-key', fake.openaiProject],
    ['gcp-api-key', fake.googleApi],
    ['linear-key', `LINEAR_TOKEN=${fake.linear}`],
    ['npm-token', fake.npm],
    ['jwt', `Bearer ${fake.jwt}`],
    ['private-key', fake.privateKey],
    [
      'url-credentials',
      `postgres://app:${fake.urlPassword}@db.prod.internal:5432/main`,
    ],
  ]
  for (const [id, text] of positives) {
    test(`finds ${id}`, () => {
      expect(types(text)).toContain(`secret:rule:${id}`)
    })
  }

  test('a private key in a one-line .env value, with escaped newlines', () => {
    expect(
      types(`JWT_KEY="${fake.privateKey.replace(/\n/g, '\\n')}"`),
    ).toContain('secret:rule:private-key')
  })

  test('rejects placeholders, doc examples and sequential runs', () => {
    const j = (...p: string[]) => p.join('')
    for (const text of [
      j('AK', 'IA', 'IOSFODNN7', 'EXAMPLE'),
      j('sk', '_live_', 'abcdefghijklmnop1234'),
      j('gh', 'p_', 'x'.repeat(36)),
      j('xo', 'xb-', 'your-token-here'),
      '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
    ]) {
      expect(
        detectInText(text).filter(
          (d) => d.kind === 'secret' && d.confidence !== 'low',
        ),
      ).toEqual([])
    }
  })

  test('ignores dev credentials on local hosts', () => {
    expect(types('postgres://postgres:postgres@localhost:5432/dev')).toEqual([])
    expect(types(`redis://default:${fake.urlPassword}@redis:6379`)).toEqual([])
  })

  test('the generic assignment rule needs entropy and mixed characters, and is low confidence', () => {
    const [d] = detectInText(`const apiKey = "${fake.highEntropy}"`).filter(
      (x) => x.detector === 'rule:generic-secret',
    )
    expect(d?.confidence).toBe('low')
    expect(
      detectInText('password = "correcthorsebattery"').filter(
        (x) => x.detector === 'rule:generic-secret',
      ),
    ).toEqual([])
    expect(
      detectInText('token: args.token.value').filter(
        (x) => x.kind === 'secret',
      ),
    ).toEqual([])
  })

  test('the keyword prefilter skips text without a keyword', () => {
    expect(detectInText('plain prose about nothing in particular')).toEqual([])
  })

  test('a secret inside a longer secret is reported once', () => {
    const url = `https://hooks.slack.com/services/${fake.highEntropy}${fake.highEntropy}`
    expect(detectInText(url).filter((d) => d.kind === 'secret')).toHaveLength(1)
  })
})

describe('PII rules', () => {
  test('emails, minus test domains, role addresses, bot trailers and URL credentials', () => {
    expect(types('mail jane.doe@acme-corp.io today')).toEqual([
      'pii:rule:email',
    ])
    for (const text of [
      'a@example.com',
      'noreply@acme-corp.io',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      '12345+octo@users.noreply.github.com',
      'logo@2x.png',
      'git@github.com:org/repo.git',
      `https://user:${fake.urlPassword}@db.prod.internal`,
    ]) {
      expect(detectInText(text).filter((d) => d.type === 'email')).toEqual([])
    }
  })

  test('cards need Luhn, a network prefix, and separators or context; test cards are ignored', () => {
    expect(luhnValid('4539578763621486')).toBe(true)
    expect(luhnValid('4539578763621487')).toBe(false)
    expect(
      detectInText('card 4539 5787 6362 1486').map((d) => [
        d.type,
        d.confidence,
      ]),
    ).toEqual([['credit-card', 'high']])
    expect(
      detectInText('id 4539578763621486 at 0.4539578763621486').filter(
        (d) => d.type === 'credit-card',
      ),
    ).toEqual([])
    expect(
      detectInText('use 4242 4242 4242 4242 in tests').filter(
        (d) => d.type === 'credit-card',
      ),
    ).toEqual([])
  })

  test('IBAN mod-97, SSN rules with context, phones with formatting', () => {
    expect(ibanValid('GB82WEST12345698765432')).toBe(true)
    expect(ibanValid('GB82WEST12345698765433')).toBe(false)
    expect(ssnValid('536-90-4399')).toBe(true)
    expect(ssnValid('666-12-3456')).toBe(false)
    expect(ssnValid('123-45-6789')).toBe(false)
    expect(types('my SSN is 536-90-4399')).toContain('pii:rule:us-ssn')
    expect(types('ticket 536-90-4399')).not.toContain('pii:rule:us-ssn')
    expect(types('call me at (415) 555-2671')).toContain('pii:rule:phone')
    expect(types('call me at 4155552671')).not.toContain('pii:rule:phone')
    expect(types('reach +44 20 7946 0958')).toContain('pii:rule:phone')
  })

  test('public IPs only; private, loopback, documentation and version strings are dropped', () => {
    expect(publicIpv4('34.120.5.9')).toBe(true)
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '192.168.1.1',
      '172.20.0.1',
      '192.0.2.10',
      '169.254.1.1',
    ]) {
      expect(publicIpv4(ip)).toBe(false)
    }
    expect(
      detectInText('ssh to host 34.120.5.9').map((d) => [d.type, d.confidence]),
    ).toEqual([['ip-address', 'medium']])
    expect(
      detectInText('bump to v34.120.5.9').filter(
        (d) => d.type === 'ip-address',
      ),
    ).toEqual([])
  })

  test('crypto wallets need a valid checksum or context', () => {
    expect(base58CheckValid('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe(true)
    expect(base58CheckValid('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3')).toBe(false)
    const eth = `0x${'a1b2c3d4e5'.repeat(4)}`
    expect(types(`send to wallet ${eth}`)).toContain('pii:rule:crypto-wallet')
    expect(types(`contract hash ${eth}`)).not.toContain(
      'pii:rule:crypto-wallet',
    )
  })

  test('entropy', () => {
    expect(shannonEntropy('aaaa')).toBe(0)
    expect(shannonEntropy(fake.highEntropy)).toBeGreaterThan(3.5)
  })
})

describe('masking and fingerprints', () => {
  test('never return the raw value', () => {
    const cases = [
      { kind: 'secret' as const, type: 'GitHub token', value: fake.githubPat },
      { kind: 'pii' as const, type: 'email', value: 'jane.doe@acme-corp.io' },
      { kind: 'pii' as const, type: 'credit-card', value: '4539578763621486' },
      { kind: 'pii' as const, type: 'person', value: 'Jane Doe' },
      { kind: 'pii' as const, type: 'us-ssn', value: '536-90-4399' },
    ]
    for (const c of cases) expect(maskValue(c)).not.toContain(c.value)
    expect(maskValue(cases[0]!)).toBe(`ghp_…(${fake.githubPat.length})`)
    expect(maskValue(cases[1]!)).toBe('j•••@a•••.io')
    expect(maskValue(cases[2]!)).toBe('•••• 1486')
    expect(maskValue(cases[3]!)).toBe('J. D.')
  })

  test('fingerprints are stable for a salt and differ across salts', () => {
    expect(fingerprint('x', SALT)).toBe(fingerprint('x', SALT))
    expect(fingerprint('x', SALT)).not.toBe(
      fingerprint('x', Buffer.alloc(32, 8)),
    )
    expect(fingerprint('x', SALT)).toHaveLength(16)
  })

  test('the salt is created once and reused', () => {
    const path = join(dir, 'salt')
    const a = loadSalt(path)
    expect(loadSalt(path).equals(a)).toBe(true)
  })
})

/** A transcript holding fake secrets, written to a temp projects dir: never committed. */
function writeSecretTranscript(root: string): string {
  const id = '99999999-9999-4999-8999-999999999999'
  const d = join(root, '-tmp-secret-app')
  mkdirSync(d, { recursive: true })
  const base = {
    sessionId: id,
    cwd: '/tmp/secret-app',
    timestamp: '2026-11-05T10:00:00.000Z',
    isSidechain: false,
  }
  const lines = [
    {
      ...base,
      type: 'user',
      origin: { kind: 'human' },
      message: {
        role: 'user',
        content: `deploy with ${fake.githubPat}, ping jane.doe@acme-corp.io`,
      },
    },
    {
      ...base,
      type: 'assistant',
      message: {
        id: 'm1',
        model: 'claude-opus-5-5',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Bash',
            input: { command: 'cat .env' },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: `LINEAR_TOKEN=${fake.linear}\nSTRIPE=${fake.stripeLive}`,
          },
        ],
      },
      toolUseResult: { stdout: `LINEAR_TOKEN=${fake.linear}` },
    },
    {
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'image', source: {} },
              { type: 'text', text: `again ${fake.githubPat}` },
            ],
          },
        ],
      },
    },
    {
      ...base,
      type: 'user',
      isMeta: true,
      message: {
        role: 'user',
        content: `<system-reminder>${fake.npm}</system-reminder>`,
      },
    },
  ]
  writeFileSync(
    join(d, `${id}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  )
  return id
}

describe('segment extraction and collection', () => {
  test('visits prompts, tool input and output, skips harness text and toolUseResult', async () => {
    const id = writeSecretTranscript(dir)
    const seen: TextVisit[] = []
    await parseSessionFile(
      join(dir, '-tmp-secret-app', `${id}.jsonl`),
      emptyCounters(),
      (s) => seen.push(s),
    )
    expect(seen.map((s) => [s.source, s.tool])).toEqual([
      ['typed-prompt', null],
      ['tool-input', 'Bash:file_ops'],
      ['tool-output', 'Bash:file_ops'],
      ['tool-output', 'Bash:file_ops'],
    ])
    expect(seen.some((s) => s.text.includes(fake.npm))).toBe(false)
  })

  test('the collector masks, dedupes per session and counts occurrences', async () => {
    writeSecretTranscript(dir)
    const collector = new SensitiveCollector(SALT, {
      rules: true,
      modelScope: null,
    })
    const { sessions } = await loadSessions(
      [{ source: claudeSource, root: dir }],
      {
        sinceMs: 0,
        textVisitor: (id) => collector.visitor(id),
      },
    )
    const findings = collector.findings(
      new Map(sessions.map((s) => [s.id, s.projectLabel])),
    )
    const byType = Object.fromEntries(findings.map((f) => [f.type, f]))
    expect(byType['GitHub token']).toMatchObject({
      source: 'typed-prompt',
      occurrences: 2,
    })
    expect(byType['Linear API key']).toMatchObject({
      source: 'tool-output',
      tool: 'Bash:file_ops',
      occurrences: 1,
    })
    expect(byType['Stripe secret key']).toBeDefined()
    expect(byType.email).toMatchObject({ masked: 'j•••@a•••.io' })
    expect(byType['npm token']).toBeUndefined()
    // Nothing raw in what the report receives.
    const json = JSON.stringify(findings)
    for (const raw of [
      fake.githubPat,
      fake.linear,
      fake.stripeLive,
      'jane.doe@acme-corp.io',
    ]) {
      expect(json).not.toContain(raw)
    }
  })

  test('findings for sessions the scan dropped are discarded', () => {
    const collector = new SensitiveCollector(SALT, {
      rules: true,
      modelScope: null,
    })
    collector.visitor('kept')({
      source: 'typed-prompt',
      tool: null,
      ts: '',
      text: fake.githubPat,
    })
    collector.visitor('dropped')({
      source: 'typed-prompt',
      tool: null,
      ts: '',
      text: fake.linear,
    })
    expect(
      collector.findings(new Map([['kept', 'p']])).map((f) => f.sessionId),
    ).toEqual(['kept'])
  })

  test('the summary counts unique values, occurrences and sessions, secrets first', () => {
    const collector = new SensitiveCollector(SALT, {
      rules: true,
      modelScope: null,
    })
    const v = collector.visitor('s1')
    v({
      source: 'tool-output',
      tool: 'Read:env',
      ts: '',
      text: `${fake.githubPat} and jane.doe@acme-corp.io`,
    })
    v({ source: 'typed-prompt', tool: null, ts: '', text: fake.githubPat })
    collector.visitor('s2')({
      source: 'typed-prompt',
      tool: null,
      ts: '',
      text: 'bob.roe@acme-corp.io',
    })
    const s = summarizeSensitive(
      collector.findings(
        new Map([
          ['s1', 'p'],
          ['s2', 'p'],
        ]),
      ),
    )
    expect(
      s.summary.map((r) => [
        r.kind,
        r.type,
        r.uniqueValues,
        r.occurrences,
        r.sessions,
      ]),
    ).toEqual([
      ['secret', 'GitHub token', 1, 2, 1],
      ['pii', 'email', 2, 2, 2],
    ])
    expect(s.totals).toMatchObject({
      secretValues: 1,
      piiValues: 2,
      sessions: 2,
    })
  })
})

describe('NER helpers', () => {
  const tok = (
    entity: string,
    word: string,
    index: number,
    score = 0.99,
  ): NerToken => ({ entity, word, index, score })

  test('merges B-/I- pieces and ## subwords', () => {
    expect(
      aggregateTokens([
        tok('B-PER', 'Jo', 1),
        tok('I-PER', '##hn', 2),
        tok('I-PER', 'Smith', 3),
        tok('B-LOC', 'Berlin', 6),
        tok('B-ORG', 'Acme', 8),
      ]).map((e) => ({ ...e, score: Math.round(e.score * 100) / 100 })),
    ).toEqual([
      { type: 'person', value: 'John Smith', score: 0.99 },
      { type: 'location', value: 'Berlin', score: 0.99 },
    ])
  })

  test('accepts two-word names, rejects code-like spans, low scores and assistant names', () => {
    expect(
      acceptEntity({ type: 'person', value: 'Jane Doe', score: 0.95 }),
    ).toBe('medium')
    expect(
      acceptEntity({ type: 'person', value: 'Jane', score: 0.99 }),
    ).toBeNull()
    expect(
      acceptEntity({ type: 'person', value: 'Jane Doe', score: 0.6 }),
    ).toBeNull()
    expect(
      acceptEntity({ type: 'person', value: 'useState Hook', score: 0.99 }),
    ).toBeNull()
    expect(
      acceptEntity({ type: 'person', value: 'Claude Code', score: 0.99 }),
    ).toBeNull()
    expect(
      acceptEntity({ type: 'location', value: 'Lisbon', score: 0.99 }),
    ).toBe('low')
    expect(
      acceptEntity({ type: 'location', value: 'US', score: 0.99 }),
    ).toBeNull()
  })

  test('chunks at whitespace and skips chunks with no capitalized word', () => {
    const chunks = chunkText(
      `${'word '.repeat(300)}Jane Doe lives here. ${'x '.repeat(600)}`,
      1000,
    )
    expect(chunks.every((c) => c.length <= 1000)).toBe(true)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('Jane Doe')
  })

  test('masks known names in card text without holding the names', () => {
    const fps = new Set([fingerprint('Jane Doe', SALT)])
    expect(
      maskKnownNames('Email Jane Doe About The Invoice today', fps, SALT),
    ).toBe('Email [name] About The Invoice today')
    expect(maskKnownNames('Ask John Roe', fps, SALT)).toBe('Ask John Roe')
  })

  test('runNer uses the engine once per new chunk, caches masked results, and never caches raw text', async () => {
    let calls = 0
    const engine: NerEngine = {
      async detect(text) {
        calls++
        return text.includes('Jane')
          ? [tok('B-PER', 'Jane', 1), tok('I-PER', 'Doe', 2)]
          : []
      },
      close() {
        // nothing to release in the fake
      },
    }
    const cache = new Cache(join(dir, 'cache'))
    const emitted: string[] = []
    const texts = [
      'Please ask Jane Doe.',
      'Nothing Here at all.',
      'Please ask Jane Doe.',
    ]
    const run = () =>
      runNer({
        texts,
        engine: async () => engine,
        cache,
        salt: SALT,
        emit: (i, e) => emitted.push(`${i}:${e.masked}`),
      })
    const first = await run()
    expect(calls).toBe(2)
    expect(first.cachedChunks).toBe(1)
    expect(emitted).toEqual(['0:J. D.', '2:J. D.'])
    const second = await run()
    expect(calls).toBe(2)
    expect(second.cachedChunks).toBe(3)
    const files = new Bun.Glob('**/*.json').scanSync(join(dir, 'cache'))
    for (const f of files)
      expect(readFileSync(join(dir, 'cache', f), 'utf8')).not.toContain('Jane')
  })
})

describe('model download', () => {
  const body = Buffer.from('model-bytes-'.repeat(1000))
  const sha = createHash('sha256').update(body).digest('hex')
  let requests: { range: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const range = req.headers.get('range')
      requests.push({ range })
      if (new URL(req.url).pathname === '/missing')
        return new Response('nope', { status: 404 })
      const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
      return new Response(body.subarray(start), { status: range ? 206 : 200 })
    },
  })
  afterAll(() => server.stop(true))
  beforeEach(() => {
    requests = []
  })
  const url = (p = '/file') => `http://127.0.0.1:${server.port}${p}`

  test('downloads, verifies and renames into place', async () => {
    const dest = join(dir, 'm', 'file.bin')
    await downloadVerified(url(), dest, { size: body.length, sha256: sha })
    expect(readFileSync(dest).equals(body)).toBe(true)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  test('resumes a partial download with a Range request', async () => {
    const dest = join(dir, 'file.bin')
    writeFileSync(`${dest}.part`, body.subarray(0, 5000))
    await downloadVerified(url(), dest, { size: body.length, sha256: sha })
    expect(requests[0]?.range).toBe('bytes=5000-')
    expect(readFileSync(dest).equals(body)).toBe(true)
  })

  test('a hash mismatch deletes the file and throws', async () => {
    const dest = join(dir, 'file.bin')
    await expect(
      downloadVerified(url(), dest, {
        size: body.length,
        sha256: '0'.repeat(64),
      }),
    ).rejects.toThrow(/Checksum mismatch/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  test('an HTTP error or no network fails clearly', async () => {
    await expect(
      downloadVerified(url('/missing'), join(dir, 'x'), {
        size: 1,
        sha256: sha,
      }),
    ).rejects.toThrow(/404/)
    const offline = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(
      downloadVerified(
        url(),
        join(dir, 'y'),
        { size: 1, sha256: sha },
        { fetch: offline },
      ),
    ).rejects.toThrow(/fetch failed/)
  })

  test('extracts one file from a gzipped tar', () => {
    const entry = (name: string, data: Buffer) => {
      const h = Buffer.alloc(512)
      h.write(name, 0)
      h.write('0000644\0', 100)
      h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
      h.write('0', 156)
      h.write('ustar\0', 257)
      const pad = Buffer.alloc((512 - (data.length % 512)) % 512)
      return Buffer.concat([h, data, pad])
    }
    const tgz = gzipSync(
      Buffer.concat([
        entry('package/a.txt', Buffer.from('aaa')),
        entry('package/lib/x.so', Buffer.from('lib')),
        Buffer.alloc(1024),
      ]),
    )
    expect(extractFromTarGz(tgz, 'package/lib/x.so')?.toString()).toBe('lib')
    expect(extractFromTarGz(tgz, 'package/none')).toBeNull()
  })
})

describe('scan end to end with secrets in transcripts', () => {
  test('report.html and report.json never contain a raw value', async () => {
    const { scan } = await import('../scan.ts')
    const root = join(dir, 'projects')
    writeSecretTranscript(root)
    const out = join(dir, 'out')
    const res = await scan({
      sources: [{ source: claudeSource, root }],
      cacheDir: join(dir, 'cache'),
      sinceMs: 0,
      sinceLabel: 'all',
      model: 'haiku',
      noLlm: true,
      outDir: out,
      json: false,
      yes: true,
      sensitive: true,
      piiModel: false,
      piiModelScope: 'prompts',
      salt: SALT,
      log: () => undefined,
      out: () => undefined,
    })
    expect(res.exitCode).toBe(0)
    expect(res.report?.sensitive.totals.secretValues).toBe(3)
    const html = readFileSync(join(out, 'report.html'), 'utf8')
    const json = readFileSync(join(out, 'report.json'), 'utf8')
    expect(html).toContain('Rotate: ')
    for (const raw of [
      fake.githubPat,
      fake.linear,
      fake.stripeLive,
      'jane.doe@acme-corp.io',
    ]) {
      expect(html).not.toContain(raw)
      expect(json).not.toContain(raw)
      // Not even a long prefix of it.
      expect(json).not.toContain(raw.slice(0, 12))
    }
  })

  test('--no-sensitive skips the scan', async () => {
    const { scan } = await import('../scan.ts')
    const root = join(dir, 'projects')
    writeSecretTranscript(root)
    const res = await scan({
      sources: [{ source: claudeSource, root }],
      cacheDir: join(dir, 'cache'),
      sinceMs: 0,
      sinceLabel: 'all',
      model: 'haiku',
      noLlm: true,
      outDir: join(dir, 'out'),
      json: false,
      yes: true,
      sensitive: false,
      piiModel: false,
      piiModelScope: 'prompts',
      salt: SALT,
      log: () => undefined,
      out: () => undefined,
    })
    expect(res.report?.sensitive.enabled).toBe(false)
    expect(res.report?.sensitive.findings).toEqual([])
  })
})

describe('model scope', () => {
  test('prompts scope keeps what people wrote; all adds tool text and subagents', async () => {
    const { inModelScope } = await import('./collect.ts')
    expect(inModelScope('typed-prompt', 'prompts')).toBe(true)
    expect(inModelScope('assistant-text', 'prompts')).toBe(true)
    expect(inModelScope('tool-output', 'prompts')).toBe(false)
    expect(inModelScope('subagent', 'prompts')).toBe(false)
    expect(inModelScope('tool-output', 'all')).toBe(true)
  })
})

// Opt-in: downloads the real model (~190 MB, cached in ~/.frisk/models) and runs it.
describe.skipIf(!process.env.FRISK_MODEL_TEST)(
  'real model (FRISK_MODEL_TEST=1)',
  () => {
    test('finds a person in a synthetic sentence', async () => {
      const { planModel, runModelPass } = await import('./run.ts')
      const plan = planModel({
        enabled: true,
        piiModel: true,
        modelScope: 'prompts',
        salt: SALT,
      })
      if (!plan.ok) throw new Error(plan.message)
      const collector = new SensitiveCollector(SALT, {
        rules: false,
        modelScope: 'prompts',
      })
      collector.visitor('s1')({
        source: 'typed-prompt',
        tool: null,
        ts: '',
        text: 'Please email Maria Gonzalez about the refund.',
      })
      const res = await runModelPass({
        collector,
        sessions: [{ id: 's1' } as never],
        plan,
        cache: new Cache(join(dir, 'cache')),
        salt: SALT,
        scope: 'prompts',
        log: () => undefined,
      })
      expect(
        res.personFingerprints.has(fingerprint('Maria Gonzalez', SALT)),
      ).toBe(true)
    }, 300_000)
  },
)

describe('one line per value', () => {
  test('the same value across sessions and sources becomes one entry', () => {
    const collector = new SensitiveCollector(SALT, {
      rules: true,
      modelScope: null,
    })
    collector.visitor('s1')({
      source: 'tool-output',
      tool: 'Bash:git',
      ts: '2026-11-01T10:00:00Z',
      text: 'Author: jane.doe@acme-corp.io',
    })
    collector.visitor('s2')({
      source: 'typed-prompt',
      tool: null,
      ts: '2026-11-03T10:00:00Z',
      text: 'ask jane.doe@acme-corp.io and jane.doe@acme-corp.io',
    })
    collector.visitor('s3')({
      source: 'tool-output',
      tool: 'Bash:git',
      ts: '2026-11-02T10:00:00Z',
      text: 'jane.doe@acme-corp.io',
    })
    collector.visitor('s3')({
      source: 'tool-output',
      tool: 'Bash:git',
      ts: '2026-11-02T10:00:00Z',
      text: 'john.roe@acme-corp.io',
    })
    const projects = new Map([
      ['s1', 'a'],
      ['s2', 'b'],
      ['s3', 'a'],
    ])
    const { values } = summarizeSensitive(collector.findings(projects))
    expect(values).toHaveLength(2)
    const jane = values[0]!
    expect(jane).toMatchObject({
      type: 'email',
      masked: 'j•••@a•••.io',
      occurrences: 3,
      sessions: 3,
      projects: ['a', 'b'],
      firstSeen: '2026-11-01T10:00:00Z',
      lastSeen: '2026-11-03T10:00:00Z',
      detectors: ['rule:email'],
    })
    expect(jane.sources).toEqual([
      { source: 'tool-output', tool: 'Bash:git', count: 2 },
      { source: 'typed-prompt', tool: null, count: 1 },
    ])
    expect(jane.seenIn.map((x) => x.sessionId)).toEqual(['s2', 's3', 's1'])
  })

  test('different values with the same masked form stay separate', () => {
    const collector = new SensitiveCollector(SALT, {
      rules: true,
      modelScope: null,
    })
    collector.visitor('s1')({
      source: 'typed-prompt',
      tool: null,
      ts: '',
      text: 'jane@acme-corp.io and jack@apex-labs.io',
    })
    const { values } = summarizeSensitive(
      collector.findings(new Map([['s1', 'p']])),
    )
    expect(values.map((v) => v.masked)).toEqual([
      'j•••@a•••.io',
      'j•••@a•••.io',
    ])
    expect(new Set(values.map((v) => v.fingerprint)).size).toBe(2)
  })

  test('a value seen in several sessions renders as a single line', async () => {
    const { scan } = await import('../scan.ts')
    const root = join(dir, 'projects')
    writeSecretTranscript(root)
    // A second session repeating the same GitHub token.
    const src = join(
      root,
      '-tmp-secret-app',
      '99999999-9999-4999-8999-999999999999.jsonl',
    )
    writeFileSync(
      join(
        root,
        '-tmp-secret-app',
        '88888888-8888-4888-8888-888888888888.jsonl',
      ),
      readFileSync(src, 'utf8').replaceAll(
        '99999999-9999-4999-8999-999999999999',
        '88888888-8888-4888-8888-888888888888',
      ),
    )
    const out = join(dir, 'out')
    const res = await scan({
      sources: [{ source: claudeSource, root }],
      cacheDir: join(dir, 'cache'),
      sinceMs: 0,
      sinceLabel: 'all',
      model: 'haiku',
      noLlm: true,
      outDir: out,
      json: false,
      yes: true,
      sensitive: true,
      piiModel: false,
      piiModelScope: 'prompts',
      salt: SALT,
      log: () => undefined,
      out: () => undefined,
    })
    const token = res.report?.sensitive.values.find(
      (v) => v.type === 'GitHub token',
    )
    expect(token).toMatchObject({ sessions: 2, occurrences: 4 })
    const html = readFileSync(join(out, 'report.html'), 'utf8')
    expect(html.split(`<code>${token!.masked}</code>`).length - 1).toBe(1)
    expect(html).not.toContain(fake.githubPat)
  })
})

describe('--reveal', () => {
  const run = async (reveal: boolean) => {
    const { scan } = await import('../scan.ts')
    const root = join(dir, 'projects')
    writeSecretTranscript(root)
    const out = join(dir, reveal ? 'out-reveal' : 'out-masked')
    const res = await scan({
      sources: [{ source: claudeSource, root }],
      cacheDir: join(dir, 'cache'),
      sinceMs: 0,
      sinceLabel: 'all',
      model: 'haiku',
      noLlm: true,
      outDir: out,
      json: false,
      yes: true,
      sensitive: true,
      piiModel: false,
      piiModelScope: 'prompts',
      reveal,
      salt: SALT,
      log: () => undefined,
      out: () => undefined,
    })
    return { res, out }
  }

  test('puts raw values in report.html and report.json, warns, and writes them 0600', async () => {
    const { res, out } = await run(true)
    expect(res.report?.sensitive.revealed).toBe(true)
    const html = readFileSync(join(out, 'report.html'), 'utf8')
    const json = readFileSync(join(out, 'report.json'), 'utf8')
    for (const raw of [fake.githubPat, fake.linear, 'jane.doe@acme-corp.io']) {
      expect(html).toContain(raw)
      expect(json).toContain(raw)
    }
    expect(html).toContain('This report contains unmasked secrets')
    for (const f of ['report.html', 'report.json']) {
      expect(statSync(join(out, f)).mode & 0o777).toBe(0o600)
    }
  })

  test('raw values never reach the cache, and without the flag the report stays masked', async () => {
    await run(true)
    const { out } = await run(false)
    const html = readFileSync(join(out, 'report.html'), 'utf8')
    expect(html).not.toContain(fake.githubPat)
    expect(html).not.toContain('This report contains unmasked secrets')
    const cacheDir = join(dir, 'cache')
    if (existsSync(cacheDir)) {
      for (const f of new Bun.Glob('**/*').scanSync(cacheDir)) {
        expect(readFileSync(join(cacheDir, f), 'utf8')).not.toContain(
          fake.githubPat,
        )
      }
    }
  })

  test('NER cache hits recover the raw name from the text, without caching it', async () => {
    const engine: NerEngine = {
      async detect(text) {
        return text.includes('Jane')
          ? [
              { entity: 'B-PER', word: 'Jane', index: 1, score: 0.99 },
              { entity: 'I-PER', word: 'Doe', index: 2, score: 0.99 },
            ]
          : []
      },
      close() {
        // nothing to release in the fake
      },
    }
    const cache = new Cache(join(dir, 'cache'))
    const values: (string | undefined)[] = []
    const opts = {
      texts: ['Please ask Jane Doe about it.'],
      engine: async () => engine,
      cache,
      salt: SALT,
      reveal: true,
      emit: (_i: number, _e: unknown, value?: string) => values.push(value),
    }
    await runNer(opts)
    const second = await runNer(opts)
    expect(second.cachedChunks).toBe(1)
    expect(values).toEqual(['Jane Doe', 'Jane Doe'])
    for (const f of new Bun.Glob('**/*.json').scanSync(join(dir, 'cache'))) {
      expect(readFileSync(join(dir, 'cache', f), 'utf8')).not.toContain('Jane')
    }
    expect(
      recoverByFingerprint('x Jane Doe y', fingerprint('Jane Doe', SALT), SALT),
    ).toBe('Jane Doe')
    expect(
      recoverByFingerprint('nothing here', fingerprint('Jane Doe', SALT), SALT),
    ).toBeNull()
  })
})

describe('NER value shape', () => {
  const t = (entity: string, word: string, index: number): NerToken => ({
    entity,
    word,
    index,
    score: 0.99,
  })
  test('punctuation joins without spaces, so the value matches the text', () => {
    expect(
      aggregateTokens([
        t('B-PER', 'Sean', 1),
        t('I-PER', 'O', 2),
        t('I-PER', "'", 3),
        t('I-PER', 'Brien', 4),
      ])[0]?.value,
    ).toBe("Sean O'Brien")
    expect(
      aggregateTokens([
        t('B-PER', 'Jean', 1),
        t('I-PER', '-', 2),
        t('I-PER', 'Luc', 3),
      ])[0]?.value,
    ).toBe('Jean-Luc')
  })

  test('recovery finds a name the model cut off mid-word', () => {
    expect(
      recoverByFingerprint(
        'play it by Nico Carlton now',
        fingerprint('Nico Car', SALT),
        SALT,
      ),
    ).toBe('Nico Carlton')
  })
})
