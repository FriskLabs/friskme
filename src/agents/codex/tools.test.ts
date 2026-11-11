import { describe, expect, test } from 'bun:test'
import {
  codexToolDetail,
  codexToolKind,
  outputIsError,
  outputText,
  patchFirstPath,
  shellCommand,
} from './tools.ts'

describe('Codex tools', () => {
  test('maps tool names onto kinds', () => {
    expect(codexToolKind('exec_command')).toBe('shell')
    expect(codexToolKind('write_stdin')).toBe('shell')
    expect(codexToolKind('apply_patch')).toBe('edit')
    expect(codexToolKind('spawn_agent')).toBe('subagent')
    expect(codexToolKind('update_plan')).toBe('plan')
    expect(codexToolKind('mcp__linear__get_issue')).toBe('mcp')
    expect(codexToolKind('request_user_input')).toBe('other')
  })

  test('unwraps shell argv and strings', () => {
    expect(
      shellCommand('shell', { command: ['bash', '-lc', 'git status'] }),
    ).toBe('git status')
    expect(shellCommand('shell', { command: ['ls', '-la'] })).toBe('ls -la')
    expect(shellCommand('exec_command', { cmd: 'rg foo' })).toBe('rg foo')
    expect(shellCommand('write_stdin', { chars: 'y' })).toBeNull()
  })

  test('details stay coarse', () => {
    expect(codexToolDetail('exec_command', { cmd: 'git push' })).toBe('git')
    expect(
      codexToolDetail(
        'apply_patch',
        '*** Begin Patch\n*** Add File: a/b.py\n+x\n*** End Patch',
      ),
    ).toBe('py')
    expect(codexToolDetail('spawn_agent', {})).toBe('general')
    expect(codexToolDetail('write_stdin', {})).toBe('stdin')
    expect(patchFirstPath('nothing here')).toBeNull()
  })

  test('reads exit codes from JSON and text outputs', () => {
    expect(
      outputIsError(JSON.stringify({ output: '', metadata: { exit_code: 2 } })),
    ).toBe(true)
    expect(
      outputIsError(JSON.stringify({ output: '', metadata: { exit_code: 0 } })),
    ).toBe(false)
    expect(
      outputIsError('Chunk ID: 1\nProcess exited with code 127\nOutput:'),
    ).toBe(true)
    expect(outputIsError('Exit code: 0\nOutput:')).toBe(false)
    expect(outputIsError('apply_patch verification failed: x')).toBe(true)
    expect(outputIsError('{not json')).toBe(false)
    expect(outputIsError(undefined)).toBe(false)
  })

  test('unwraps output text', () => {
    expect(outputText(JSON.stringify({ output: 'hi', metadata: {} }))).toBe(
      'hi',
    )
    expect(outputText('plain')).toBe('plain')
    expect(
      outputText([{ type: 'input_text', text: 'a' }, { type: 'image' }]),
    ).toBe('a')
  })
})
