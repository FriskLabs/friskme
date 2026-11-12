import { describe, expect, test } from 'bun:test'
import { createStatus, formatElapsed } from './progress.ts'

function fakeStream(isTTY: boolean, columns = 120) {
  const writes: string[] = []
  const stream = {
    isTTY,
    columns,
    write: (s: string) => {
      writes.push(s)
      return true
    },
  } as unknown as NodeJS.WriteStream
  return { stream, writes, text: () => writes.join('') }
}

function setup(opts: { isTTY?: boolean; columns?: number } = {}) {
  const f = fakeStream(opts.isTTY ?? true, opts.columns)
  let t = 0
  const status = createStatus({
    stream: f.stream,
    env: {},
    now: () => t,
    interval: 0,
  })
  return { ...f, status, advance: (ms: number) => (t += ms) }
}

/** The text currently on the live line: after the last clear, if any. */
function liveLine(writes: string[]): string {
  const all = writes.join('')
  return all.slice(all.lastIndexOf('\r\x1b[2K') + 5)
}

describe('formatElapsed', () => {
  test('minutes and zero-padded seconds', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(42_900)).toBe('0:42')
    expect(formatElapsed(64_000)).toBe('1:04')
    expect(formatElapsed(725_000)).toBe('12:05')
  })
})

describe('createStatus on a terminal', () => {
  test('a phase shows its text and elapsed time', () => {
    const { status, writes, advance } = setup()
    status.phase('Finding session files')
    expect(liveLine(writes)).toMatch(/^. Finding session files… · 0:00$/)
    advance(3_000)
    status.note('one')
    expect(liveLine(writes)).toMatch(/Finding session files… · one · 0:03$/)
  })

  test('a bar draws at 0/N before any progress arrives', () => {
    const { status, writes } = setup()
    status.bar('Labeling 40 sessions', { total: 2, unit: 'batches' })
    expect(liveLine(writes)).toContain(
      `Labeling 40 sessions [${'.'.repeat(20)}] 0/2 batches · 0:00`,
    )
  })

  test('progress fills the bar; the last tick always draws', () => {
    const { status, writes } = setup()
    const tick = status.bar('Reading', { total: 4, unit: 'files' })
    tick(4, 4)
    expect(liveLine(writes)).toContain(`[${'#'.repeat(20)}] 4/4 files`)
  })

  test('progress redraws are throttled', () => {
    const { status, writes, advance } = setup()
    const tick = status.bar('Reading', { total: 100 })
    advance(100)
    tick(1, 100)
    const n = writes.length
    tick(2, 100)
    tick(3, 100)
    expect(writes.length).toBe(n)
    advance(60)
    tick(4, 100)
    expect(writes.length).toBe(n + 1)
  })

  test('a bar without a total shows no counts until the first tick', () => {
    const { status, writes } = setup()
    const tick = status.bar('Scanning for names', { unit: 'chunks' })
    expect(liveLine(writes)).toMatch(/Scanning for names · 0:00$/)
    tick(1, 3)
    expect(liveLine(writes)).toContain('1/3 chunks')
  })

  test('log prints above the live line and redraws it', () => {
    const { status, text, writes } = setup()
    status.phase('Working')
    status.log('Found 3 sessions')
    expect(text()).toContain('\r\x1b[2KFound 3 sessions\n')
    expect(liveLine(writes)).toContain('Working')
  })

  test('done clears the line, and leaves a summary when given one', () => {
    const { status, text, writes, advance } = setup()
    status.phase('Labeling')
    advance(5_000)
    status.done('Labeled 3 sessions')
    expect(text().endsWith('\r\x1b[2K✓ Labeled 3 sessions · 0:05\n')).toBe(true)
    status.phase('Grouping')
    status.done()
    expect(text().endsWith('\r\x1b[2K')).toBe(true)
    const n = writes.length
    status.note('ignored')
    status.done()
    expect(writes.length).toBe(n)
  })

  test('a continuing bar keeps the phase timer through to done', () => {
    const { status, text, writes, advance } = setup()
    status.bar('Labeling', { total: 4, unit: 'batches' })
    advance(30_000)
    status.bar('Retrying 3 sessions', { unit: 'batches', continues: true })
    expect(liveLine(writes)).toContain('Retrying 3 sessions')
    expect(liveLine(writes)).toContain('0:30')
    advance(12_000)
    status.done('Labeled 10 sessions')
    expect(text().endsWith('✓ Labeled 10 sessions · 0:42\n')).toBe(true)
  })

  test('a new bar without continues restarts the timer', () => {
    const { status, writes, advance } = setup()
    status.phase('Reading')
    advance(30_000)
    status.bar('Labeling', { total: 2 })
    expect(liveLine(writes)).toContain('0:00')
  })

  test('ticks from a finished phase are ignored', () => {
    const { status, writes } = setup()
    const tick = status.bar('Old', { total: 2 })
    status.phase('New')
    tick(1, 2)
    expect(liveLine(writes)).toContain('New')
    expect(liveLine(writes)).not.toContain('Old')
  })

  test('lines are cut to the terminal width', () => {
    const { status, writes } = setup({ columns: 30 })
    status.phase('A very long phase description that will not fit')
    const line = liveLine(writes)
    expect(line.length).toBe(29)
    expect(line.endsWith('…')).toBe(true)
  })

  test('an unknown width (0 columns) falls back to 80', () => {
    const { status, writes } = setup({ columns: 0 })
    status.phase('Finding session files')
    expect(liveLine(writes)).toMatch(/Finding session files… · 0:00$/)
  })

  test('the spinner timer animates and stops with the phase', async () => {
    const f = fakeStream(true)
    const status = createStatus({ stream: f.stream, env: {}, interval: 5 })
    status.phase('Waiting')
    await new Promise((r) => setTimeout(r, 40))
    status.done()
    const n = f.writes.length
    expect(n).toBeGreaterThan(3)
    await new Promise((r) => setTimeout(r, 20))
    expect(f.writes.length).toBe(n)
  })
})

describe('createStatus off a terminal', () => {
  test('writes only log lines', () => {
    const { status, writes } = setup({ isTTY: false })
    status.phase('Working')
    const tick = status.bar('Labeling', { total: 2 })
    tick(1, 2)
    status.note('x')
    status.log('Found 3 sessions')
    status.done('Labeled')
    expect(writes).toEqual(['Found 3 sessions\n'])
  })

  test('CI and dumb terminals count as non-interactive', () => {
    for (const env of [{ CI: 'true' }, { TERM: 'dumb' }]) {
      const f = fakeStream(true)
      const status = createStatus({ stream: f.stream, env, interval: 0 })
      status.phase('Working')
      expect(f.writes).toEqual([])
    }
  })
})
