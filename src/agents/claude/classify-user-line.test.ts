import { describe, expect, test } from 'bun:test'
import { classifyUserLine, commandIsIntent } from './classify-user-line.ts'

const line = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  ...extra,
})

describe('classifyUserLine: human-typed prompts', () => {
  test('origin.kind human is a typed prompt, with its source', () => {
    expect(
      classifyUserLine(
        line('Fix the bug', {
          origin: { kind: 'human' },
          promptSource: 'typed',
        }),
      ),
    ).toEqual({
      kind: 'human',
      text: 'Fix the bug',
      source: 'typed',
    })
    expect(
      classifyUserLine(
        line('next', { origin: { kind: 'human' }, promptSource: 'queued' }),
      ),
    ).toMatchObject({
      source: 'queued',
    })
    expect(
      classifyUserLine(
        line('accepted', {
          origin: { kind: 'human' },
          promptSource: 'suggestion_accepted',
        }),
      ),
    ).toMatchObject({ source: 'suggestion' })
  })

  test('pasted content wrapped in tags is still a typed prompt', () => {
    const c = classifyUserLine(
      line('<pasted_content id="x">spec</pasted_content> build it', {
        origin: { kind: 'human' },
      }),
    )
    expect(c.kind).toBe('human')
  })

  test('text blocks are joined and images dropped', () => {
    const c = classifyUserLine(
      line(
        [
          { type: 'text', text: 'Look at this' },
          { type: 'image', source: {} },
        ],
        { origin: { kind: 'human' } },
      ),
    )
    expect(c).toEqual({ kind: 'human', text: 'Look at this', source: 'typed' })
  })

  test('other origins are not prompts', () => {
    for (const kind of ['task-notification', 'peer', 'coordinator']) {
      expect(classifyUserLine(line('x', { origin: { kind } })).kind).toBe(
        'meta',
      )
    }
  })

  test('legacy lines without origin are prompts unless they are wrappers', () => {
    expect(classifyUserLine(line('Add an index'))).toEqual({
      kind: 'human',
      text: 'Add an index',
      source: 'legacy',
    })
    for (const text of [
      '<local-command-stdout>done</local-command-stdout>',
      '<local-command-caveat>Caveat</local-command-caveat>',
      '<bash-input>ls</bash-input>',
      '<bash-stdout>a</bash-stdout>',
      '<system-reminder>x</system-reminder>',
      '<task-notification>x</task-notification>',
      '[Image: original 100x100]',
      '[SYSTEM NOTIFICATION - NOT USER] x',
      '   ',
    ]) {
      expect(classifyUserLine(line(text)).kind).toBe('meta')
    }
  })

  test('meta, transcript-only and sidechain lines are never prompts', () => {
    expect(classifyUserLine(line('x', { isMeta: true })).kind).toBe('meta')
    expect(
      classifyUserLine(line('x', { isVisibleInTranscriptOnly: true })).kind,
    ).toBe('meta')
    expect(classifyUserLine(line('x', { isSidechain: true })).kind).toBe('meta')
  })
})

describe('classifyUserLine: everything else', () => {
  test('tool results carry their errors', () => {
    expect(
      classifyUserLine(
        line([
          { type: 'tool_result', tool_use_id: 'a', is_error: true },
          { type: 'tool_result', tool_use_id: 'b' },
          { type: 'tool_result', tool_use_id: 'c', is_error: false },
        ]),
      ),
    ).toEqual({
      kind: 'tool_result',
      results: [
        { toolUseId: 'a', isError: true },
        { toolUseId: 'b', isError: false },
        { toolUseId: 'c', isError: false },
      ],
    })
  })

  test('interrupts, both forms', () => {
    expect(
      classifyUserLine(
        line([{ type: 'text', text: '[Request interrupted by user]' }]),
      ),
    ).toEqual({
      kind: 'interrupt',
      forToolUse: false,
    })
    expect(
      classifyUserLine(line('[Request interrupted by user for tool use]')),
    ).toEqual({
      kind: 'interrupt',
      forToolUse: true,
    })
  })

  test('compaction summaries', () => {
    expect(
      classifyUserLine(
        line('This session is being continued…', { isCompactSummary: true }),
      ).kind,
    ).toBe('compact_summary')
  })

  test('slash command wrappers', () => {
    expect(
      classifyUserLine(
        line(
          '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>42</command-args>',
        ),
      ),
    ).toEqual({ kind: 'command', name: 'review', args: '42' })
    expect(
      classifyUserLine(line('<command-message>x</command-message>')).kind,
    ).toBe('meta')
  })
})

describe('commandIsIntent', () => {
  test('custom commands with arguments carry intent; built-ins and bare commands do not', () => {
    expect(commandIsIntent('review', '42')).toBe(true)
    expect(commandIsIntent('my-skill', 'fix the flaky test')).toBe(true)
    expect(commandIsIntent('model', 'opus')).toBe(false)
    expect(commandIsIntent('review', '')).toBe(false)
  })
})
