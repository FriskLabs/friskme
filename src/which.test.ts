import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { which } from './which.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'frisk-which-'))
}

describe('which', () => {
  test('finds an executable file on PATH, first directory wins', () => {
    const a = tempDir()
    const b = tempDir()
    for (const d of [a, b]) {
      writeFileSync(join(d, 'tool'), '#!/bin/sh\n')
      chmodSync(join(d, 'tool'), 0o755)
    }
    expect(which('tool', { PATH: [a, b].join(delimiter) }, 'linux')).toBe(
      join(a, 'tool'),
    )
  })

  test('skips non-executable files and directories', () => {
    const a = tempDir()
    writeFileSync(join(a, 'tool'), 'x')
    chmodSync(join(a, 'tool'), 0o644)
    mkdirSync(join(a, 'dir'))
    expect(which('tool', { PATH: a }, 'linux')).toBeNull()
    expect(which('dir', { PATH: a }, 'linux')).toBeNull()
  })

  test('tries PATHEXT on Windows', () => {
    const a = tempDir()
    writeFileSync(join(a, 'claude.cmd'), '@echo off\n')
    expect(which('claude', { PATH: a, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(
      join(a, 'claude.cmd'),
    )
  })

  test('returns null when PATH is empty', () => {
    expect(which('anything', {}, 'linux')).toBeNull()
  })
})
