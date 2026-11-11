import { describe, expect, test } from 'bun:test'
import { mcpServerFromToolName, parseMcpToolName } from './mcp-tool-name.ts'

describe('parseMcpToolName', () => {
  test.each([
    ['mcp__github__get_issue', { server: 'github', tool: 'get_issue' }],
    [
      'mcp__puppeteer__puppeteer_navigate',
      { server: 'puppeteer', tool: 'puppeteer_navigate' },
    ],
    ['mcp__puppeteer', { server: 'puppeteer', tool: null }],
    ['mcp__puppeteer__', { server: 'puppeteer', tool: null }],
    [
      'mcp__claude_ai_Linear__list_issues',
      { server: 'claude_ai_Linear', tool: 'list_issues' },
    ],
    [
      'mcp__plugin_my-plugin_database-tools__query',
      { server: 'plugin_my-plugin_database-tools', tool: 'query' },
    ],
    // A server containing `__` reads as its first segment (see the docstring).
    ['mcp__reports__v2__run', { server: 'reports', tool: 'v2__run' }],
  ] as const)('%p', (name, expected) => {
    expect(parseMcpToolName(name)).toEqual(expected)
  })

  test.each(['Bash', 'mcp_tool', 'mcp__', 'mcp____tool', 'MCP__x__y', ''])(
    '%p is not an MCP tool name',
    (name) => {
      expect(parseMcpToolName(name)).toBeNull()
    },
  )
})

describe('mcpServerFromToolName', () => {
  test('returns the server', () => {
    expect(mcpServerFromToolName('mcp__linear-server__get_issue')).toBe(
      'linear-server',
    )
  })

  test('returns null for a built-in tool', () => {
    expect(mcpServerFromToolName('Read')).toBeNull()
  })
})
