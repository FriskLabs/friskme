import { describe, expect, test } from 'bun:test'
import { claudeToolKind } from '../agents/claude/tools.ts'
import {
  emptyTotals,
  type Session,
  type TokenTotals,
  type ToolStep,
} from '../types.ts'
import {
  detectErrorStreaks,
  detectInterruptEnded,
  detectLoops,
  detectRepeatedBash,
  detectWaste,
  wasteTotals,
} from './detectors.ts'
import { priceTokens, RATES_AS_OF, rateFor } from './rate-table.ts'

const MODEL = 'claude-opus-5-5'
const ONE_K_OUT: TokenTotals = { ...emptyTotals(), output: 1000 }

function makeSession(
  steps: [string, string | null, boolean][],
  extra: Partial<Session> = {},
): Session {
  const toolSteps: ToolStep[] = steps.map(([tool, detail, isError], i) => ({
    tool,
    kind: claudeToolKind(tool),
    detail,
    isError,
    messageId: `m${i}`,
    toolUseId: `t${i}`,
    ts: '',
  }))
  const messageUsage = Object.fromEntries(
    toolSteps.map((s) => [s.messageId, { model: MODEL, totals: ONE_K_OUT }]),
  )
  return {
    id: 's1',
    agent: 'claude',
    project: '/p',
    projectLabel: 'p',
    branch: null,
    entrypoint: 'cli',
    sessionKind: null,
    start: '2026-11-01T00:00:00Z',
    end: '2026-11-01T01:00:00Z',
    models: [MODEL],
    prompts: [{ text: 'x', ts: '', source: 'typed' }],
    slashCommands: [],
    steps: toolSteps,
    bashRuns: [],
    errors: steps.filter((s) => s[2]).length,
    interrupts: 0,
    denials: 0,
    compactions: 0,
    endedAfterInterrupt: false,
    interruptedTurnMessageIds: [],
    tokens: {},
    subagents: { count: 0, tokens: {} },
    messageUsage,
    ...extra,
  }
}

const COST_PER_MESSAGE = (1000 * 20) / 1_000_000 // opus 5.5 output, $20/MTok

describe('detectLoops', () => {
  test('flags an edit → run → error cycle and prices only the repeats', () => {
    const s = makeSession([
      ['Read', 'ts', false],
      ['Edit', 'ts', false],
      ['Bash', 'package_manager', true],
      ['Edit', 'ts', false],
      ['Bash', 'package_manager', true],
      ['Edit', 'ts', false],
      ['Bash', 'package_manager', true],
    ])
    const [loop, ...rest] = detectLoops(s)
    expect(rest).toHaveLength(0)
    expect(loop).toMatchObject({
      kind: 'loop',
      label: '[Edit:ts → Bash:package_manager] ×3',
      editRunError: true,
      occurrences: 3,
      messageIds: ['m3', 'm4', 'm5', 'm6'],
    })
    expect(loop!.cost).toBeCloseTo(4 * COST_PER_MESSAGE, 10)
  })

  test('ignores error-free exploration and passing edit → run cycles', () => {
    const explore = makeSession(
      Array.from(
        { length: 6 },
        () => ['Bash', 'git', false] as [string, string, boolean],
      ),
    )
    expect(detectLoops(explore)).toEqual([])
    const passing = makeSession([
      ['Edit', 'ts', false],
      ['Bash', 'package_manager', false],
      ['Edit', 'ts', false],
      ['Bash', 'package_manager', false],
      ['Edit', 'ts', false],
      ['Bash', 'package_manager', false],
    ])
    expect(detectLoops(passing)).toEqual([])
  })

  test('needs the failure to repeat: one error in a long run is not a loop', () => {
    const steps = Array.from(
      { length: 8 },
      (_, i) => ['mcp', 'browser', i === 3] as [string, string, boolean],
    )
    expect(detectLoops(makeSession(steps))).toEqual([])
  })

  test('needs at least 3 repeats', () => {
    const s = makeSession([
      ['Bash', 'other', true],
      ['Bash', 'other', true],
    ])
    expect(detectLoops(s)).toEqual([])
  })
})

describe('detectRepeatedBash', () => {
  const runs = (cmds: [string, boolean][]) =>
    makeSession(
      cmds.map(() => ['Bash', 'other', false]),
      {
        bashRuns: cmds.map(([normalized, isError], i) => ({
          normalized,
          isError,
          messageId: `m${i}`,
        })),
      },
    )

  test('flags the same command 3+ times and prices the repeats', () => {
    const [item] = detectRepeatedBash(
      runs([
        ['bun test', true],
        ['ls', false],
        ['bun test', true],
        ['bun test', false],
      ]),
    )
    expect(item).toMatchObject({
      kind: 'repeated-bash',
      occurrences: 3,
      messageIds: ['m2', 'm3'],
    })
    expect(item!.label).toBe('`bun test` run 3× (2 failed)')
  })

  test('ignores polling loops that start with sleep', () => {
    expect(
      detectRepeatedBash(
        runs([
          ['sleep 60; gh pr checks', false],
          ['sleep 60; gh pr checks', false],
          ['sleep 60; gh pr checks', false],
        ]),
      ),
    ).toEqual([])
  })

  test('scrubs secrets out of the shown command', () => {
    const [item] = detectRepeatedBash(
      runs(
        Array.from(
          { length: 3 },
          () =>
            [
              'curl -H "Authorization: Bearer abcdefghijklmnopqrstuv" x',
              false,
            ] as [string, boolean],
        ),
      ),
    )
    expect(item!.label).not.toContain('abcdefghijklmnop')
  })
})

describe('detectErrorStreaks and detectInterruptEnded', () => {
  test('3+ consecutive failures make a streak', () => {
    const s = makeSession([
      ['Read', 'ts', true],
      ['Grep', null, true],
      ['Read', 'ts', true],
      ['Read', 'ts', false],
      ['Bash', 'git', true],
      ['Bash', 'git', true],
    ])
    const streaks = detectErrorStreaks(s)
    expect(streaks).toHaveLength(1)
    expect(streaks[0]).toMatchObject({
      occurrences: 3,
      messageIds: ['m0', 'm1', 'm2'],
    })
    expect(streaks[0]!.label).toBe(
      '3 failed tool calls in a row (Read:ts, Grep)',
    )
  })

  test('a session that ended on an interrupt is priced from the interrupted turn', () => {
    const s = makeSession([['Read', 'ts', false]], {
      endedAfterInterrupt: true,
      interruptedTurnMessageIds: ['m0'],
    })
    const [item] = detectInterruptEnded(s)
    expect(item).toMatchObject({ kind: 'interrupt-ended', messageIds: ['m0'] })
    expect(item!.cost).toBeCloseTo(COST_PER_MESSAGE, 10)
    expect(detectInterruptEnded(makeSession([]))).toEqual([])
  })
})

describe('wasteTotals', () => {
  test('prices each message once even when several detectors flag it', () => {
    const s = makeSession(
      [
        ['Bash', 'other', true],
        ['Bash', 'other', true],
        ['Bash', 'other', true],
      ],
      {
        bashRuns: [0, 1, 2].map((i) => ({
          normalized: 'make',
          isError: true,
          messageId: `m${i}`,
        })),
      },
    )
    const items = detectWaste(s)
    expect(items.map((i) => i.kind).sort()).toEqual([
      'error-streak',
      'loop',
      'repeated-bash',
    ])
    const totals = wasteTotals([s], items)
    expect(totals.tokens).toBe(3000)
    expect(totals.cost).toBeCloseTo(3 * COST_PER_MESSAGE, 10)
    expect(totals.sessionsAffected).toBe(1)
  })

  test('an unknown model makes an item unpriced rather than $0', () => {
    const s = makeSession([
      ['Bash', 'other', true],
      ['Bash', 'other', true],
      ['Bash', 'other', true],
    ])
    for (const u of Object.values(s.messageUsage)) u.model = 'some-future-model'
    const [streak] = detectErrorStreaks(s)
    expect(streak!.cost).toBeNull()
    expect(wasteTotals([s], [streak!]).unpricedItems).toBe(1)
  })
})

describe('rate table', () => {
  test('is dated', () => {
    expect(RATES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('prices Codex models with OpenAI rates', () => {
    expect(rateFor('gpt-5.5')).toMatchObject({
      input: 5,
      output: 30,
      cacheRead: 0.5,
    })
    expect(rateFor('gpt-5-codex-2025-09-15')).toMatchObject({ input: 1.25 })
    expect(rateFor('gpt-9-unknown')).toBeNull()
    // 1M uncached input, 1M cached, 1M output on gpt-5.4: 2.5 + 0.25 + 15.
    expect(
      priceTokens('gpt-5.4', {
        ...emptyTotals(),
        input: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
    ).toBeCloseTo(17.75)
    // gpt-5.6 lists a cache-write rate; older OpenAI models charge writes as input.
    const writes = { ...emptyTotals(), cacheWrite5m: 1_000_000 }
    expect(priceTokens('gpt-5.6-terra', writes)).toBeCloseTo(2.5)
    expect(priceTokens('gpt-5.5', writes)).toBeCloseTo(5)
    // Anthropic keeps its 1.25× default.
    expect(priceTokens('claude-opus-5-5', writes)).toBeCloseTo(5)
  })

  test('prices every token type, with 1.25× and 2× cache writes', () => {
    const t: TokenTotals = {
      input: 1e6,
      output: 1e6,
      cacheWrite5m: 1e6,
      cacheWrite1h: 1e6,
      cacheRead: 1e6,
    }
    // opus 5.5: 4 + 20 + 5 + 8 + 0.2
    expect(priceTokens('claude-opus-5-5', t)).toBeCloseTo(37.2, 6)
    // haiku 5.5: 0.1 + 0.5 + 0.125 + 0.2 + 0.01
    expect(priceTokens('claude-haiku-5-5', t)).toBeCloseTo(0.935, 6)
  })

  test('resolves dated and context-suffixed ids, and refuses to guess unknown ones', () => {
    expect(rateFor('claude-sonnet-4-6-20260101')).toEqual(
      rateFor('claude-sonnet-4-6'),
    )
    expect(rateFor('claude-opus-5-5[1m]')).toEqual(rateFor('claude-opus-5-5'))
    expect(rateFor('mistral-large')).toBeNull()
    expect(priceTokens('mistral-large', emptyTotals())).toBeNull()
  })
})
