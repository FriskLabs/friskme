import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionFile } from '../agents/claude/build-session.ts'
import { emptyCounters } from './common.ts'
import { resolveProject } from './project.ts'

const tmp = mkdtempSync(join(tmpdir(), 'frisk-project-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('resolveProject', () => {
  test('a plain folder keeps its own name', () => {
    expect(resolveProject('/nowhere/demo-app')).toEqual({
      root: '/nowhere/demo-app',
      label: 'demo-app',
    })
  })

  test('Claude Code worktrees count under the repo', () => {
    expect(
      resolveProject('/nowhere/shop/.claude/worktrees/agent-a1b2c3'),
    ).toEqual({ root: '/nowhere/shop', label: 'shop' })
    expect(
      resolveProject('/nowhere/shop/.claude/worktrees/agent-a1b2c3/src/api'),
    ).toEqual({ root: '/nowhere/shop', label: 'shop' })
  })

  test('.worktrees/<branch> counts under the repo', () => {
    expect(resolveProject('/nowhere/shop/.worktrees/fix-cart')).toEqual({
      root: '/nowhere/shop',
      label: 'shop',
    })
  })

  test('superpowers worktrees count under the repo name', () => {
    expect(
      resolveProject('/nowhere/.config/superpowers/worktrees/shop/fix-cart'),
    ).toEqual({
      root: '/nowhere/.config/superpowers/worktrees/shop',
      label: 'shop',
    })
  })

  test('a sibling worktree follows its .git file to the main repo', () => {
    const main = join(tmp, 'my-app')
    const wt = join(tmp, 'code-review-01')
    mkdirSync(join(main, '.git', 'worktrees', 'code-review-01'), {
      recursive: true,
    })
    mkdirSync(wt)
    writeFileSync(
      join(wt, '.git'),
      `gitdir: ${join(main, '.git', 'worktrees', 'code-review-01')}\n`,
    )
    expect(resolveProject(wt)).toEqual({ root: main, label: 'my-app' })
  })

  test('a relative gitdir and a bare repo resolve too', () => {
    const wt = join(tmp, 'review-02')
    mkdirSync(wt)
    writeFileSync(join(wt, '.git'), 'gitdir: ../infra.git/worktrees/review-02')
    expect(resolveProject(wt)).toEqual({
      root: join(tmp, 'infra.git'),
      label: 'infra',
    })
  })

  test('a submodule is not a worktree', () => {
    const sub = join(tmp, 'vendor-lib')
    mkdirSync(sub)
    writeFileSync(join(sub, '.git'), 'gitdir: ../app/.git/modules/vendor-lib')
    expect(resolveProject(sub)).toEqual({ root: sub, label: 'vendor-lib' })
  })

  test('a parsed session takes the repo as its project', async () => {
    const path = join(tmp, 'session.jsonl')
    const cwd = '/nowhere/shop/.claude/worktrees/agent-ff00'
    writeFileSync(
      path,
      `${JSON.stringify({
        type: 'user',
        timestamp: '2026-11-05T09:00:00.000Z',
        message: { role: 'user', content: 'Fix the cart total' },
        cwd,
      })}\n`,
    )
    const outcome = await parseSessionFile(path, emptyCounters())
    if (outcome.status !== 'ok') throw new Error(outcome.status)
    expect(outcome.session.project).toBe('/nowhere/shop')
    expect(outcome.session.projectLabel).toBe('shop')
  })
})
