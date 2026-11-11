import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { defaultSpawn } from './runner.ts'

// Runs `sh`, never the claude or codex CLI.
describe.skipIf(process.platform === 'win32')('defaultSpawn', () => {
  test('passes stdin, collects stdout, stderr and the exit code', async () => {
    const r = await defaultSpawn(
      ['sh', '-c', 'cat; echo oops >&2; exit 3'],
      'hello\nworld',
      { cwd: tmpdir() },
    )
    expect(r).toEqual({ exitCode: 3, stdout: 'hello\nworld', stderr: 'oops\n' })
  })

  test('arguments reach the child verbatim, with no shell', async () => {
    const arg = '{"a": "$HOME `x`"}\nline two'
    const r = await defaultSpawn(
      ['sh', '-c', 'printf %s "$1"', 'sh', arg],
      '',
      {
        cwd: tmpdir(),
      },
    )
    expect(r.stdout).toBe(arg)
  })

  test('runs in the given cwd', async () => {
    const r = await defaultSpawn(['pwd', '-P'], '', { cwd: '/' })
    expect(r.stdout.trim()).toBe('/')
  })

  test('a child that ignores stdin still resolves', async () => {
    const r = await defaultSpawn(['true'], 'x'.repeat(1 << 20), {
      cwd: tmpdir(),
    })
    expect(r.exitCode).toBe(0)
  })

  test('a missing binary rejects', async () => {
    await expect(
      defaultSpawn(['/nonexistent/frisk-test-binary'], '', { cwd: tmpdir() }),
    ).rejects.toThrow()
  })
})
