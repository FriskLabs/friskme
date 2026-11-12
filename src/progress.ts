/**
 * One live status line on stderr: a spinner, what frisk is doing right now,
 * optional progress counts and the time spent in this phase. It animates only
 * on an interactive terminal; anywhere else only `log` lines are written, so
 * piped, CI and `--json` stderr stay plain.
 */

export type Progress = (done: number, total: number) => void

export type BarOptions = {
  /** Shown before the first progress call; later calls carry their own total. */
  total?: number
  /** Noun after the counts: `3/12 batches`. */
  unit?: string
  /** Formats the counts, e.g. bytes as MB. */
  format?: (n: number) => string
}

export interface Status {
  /** Starts a new phase: replaces the live line and restarts its timer. */
  phase(text: string): void
  /** Starts a phase with a progress bar, drawn right away. */
  bar(label: string, opts?: BarOptions): Progress
  /** A detail after the counts (the item in progress); null clears it. */
  note(detail: string | null): void
  /** Ends the phase; with a summary, leaves `✓ summary · 0:42` behind. */
  done(summary?: string): void
  /** Prints a line above the live line. */
  log(line: string): void
}

export type StatusOptions = {
  stream?: NodeJS.WriteStream
  env?: NodeJS.ProcessEnv
  now?: () => number
  /** Spinner frame interval in ms; 0 turns the timer off (tests). */
  interval?: number
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BAR_WIDTH = 20
/** Minimum ms between redraws driven by progress calls. */
const THROTTLE = 50
const CLEAR = '\r\x1b[2K'

/** `0:42`, `12:05`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function isInteractive(
  stream: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return stream.isTTY === true && !env.CI && env.TERM !== 'dumb'
}

type Phase = {
  text: string
  started: number
  bar: { done: number; total: number } | null
  hasBar: boolean
  unit: string
  format: (n: number) => string
  note: string | null
}

export function createStatus(opts: StatusOptions = {}): Status {
  const stream = opts.stream ?? process.stderr
  const live = isInteractive(stream, opts.env)
  const now = opts.now ?? Date.now
  const interval = opts.interval ?? 100

  if (!live) {
    const noop = () => {
      // Not a terminal: no live line.
    }
    return {
      phase: noop,
      bar: () => noop,
      note: noop,
      done: noop,
      log: (line) => stream.write(`${line}\n`),
    }
  }

  let phase: Phase | null = null
  let frame = 0
  let lastDraw = 0
  let timer: ReturnType<typeof setInterval> | null = null

  const clearOnExit = () => {
    if (phase) stream.write(CLEAR)
  }
  // Ctrl-C ends the process without an 'exit' event: clear, then re-raise so
  // the default handling (and exit code) is unchanged.
  const onSigint = () => {
    clearOnExit()
    process.kill(process.pid, 'SIGINT')
  }

  function line(p: Phase): string {
    let s = `${FRAMES[frame % FRAMES.length]} ${p.text}`
    if (p.bar) {
      const { done, total } = p.bar
      const filled =
        total > 0
          ? Math.min(BAR_WIDTH, Math.round((done / total) * BAR_WIDTH))
          : 0
      s += ` [${'#'.repeat(filled)}${'.'.repeat(BAR_WIDTH - filled)}] ${p.format(done)}/${p.format(total)}`
      if (p.unit) s += ` ${p.unit}`
    } else if (!p.hasBar) {
      s += '…'
    }
    if (p.note) s += ` · ${p.note}`
    s += ` · ${formatElapsed(now() - p.started)}`
    // One column short of the width: writing the last column wraps on some terminals.
    const max = (stream.columns || 80) - 1
    return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s
  }

  function draw() {
    if (!phase) return
    lastDraw = now()
    stream.write(`${CLEAR}${line(phase)}`)
  }

  function start(p: Phase) {
    phase = p
    if (interval > 0 && !timer) {
      timer = setInterval(() => {
        frame++
        draw()
      }, interval)
      timer.unref?.()
      process.once('exit', clearOnExit)
      process.once('SIGINT', onSigint)
    }
    draw()
  }

  function end() {
    if (timer) {
      clearInterval(timer)
      timer = null
      process.removeListener('exit', clearOnExit)
      process.removeListener('SIGINT', onSigint)
    }
    if (phase) stream.write(CLEAR)
  }

  const newPhase = (text: string, bar: BarOptions | null): Phase => ({
    text,
    started: now(),
    bar:
      bar?.total !== undefined && bar.total > 0
        ? { done: 0, total: bar.total }
        : null,
    hasBar: bar !== null,
    unit: bar?.unit ?? '',
    format: bar?.format ?? String,
    note: null,
  })

  return {
    phase(text) {
      start(newPhase(text, null))
    },
    bar(label, barOpts = {}) {
      const p = newPhase(label, barOpts)
      start(p)
      return (done, total) => {
        if (phase !== p) return
        const first = p.bar === null
        p.bar = { done, total }
        // Progress may come from a synchronous loop that starves the timer,
        // so redraw here too, at most every THROTTLE ms (always on the first and last).
        if (first || done >= total || now() - lastDraw >= THROTTLE) {
          frame++
          draw()
        }
      }
    },
    note(detail) {
      if (!phase) return
      phase.note = detail
      draw()
    },
    done(summary) {
      const p = phase
      end()
      phase = null
      if (summary && p) {
        stream.write(`✓ ${summary} · ${formatElapsed(now() - p.started)}\n`)
      }
    },
    log(text) {
      if (phase) stream.write(CLEAR)
      stream.write(`${text}\n`)
      draw()
    },
  }
}
