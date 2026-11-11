/** Runs `worker` over `items` with at most `concurrency` in flight, in order of results. */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onDone?: (completed: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let completed = 0
  async function lane() {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i]!, i)
      completed++
      onDone?.(completed, items.length)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, lane),
  )
  return results
}

/** A single-line progress bar on stderr; silent when stderr is not a TTY. */
export function progressBar(
  label: string,
  stream: NodeJS.WriteStream = process.stderr,
) {
  const tty = stream.isTTY === true
  return (completed: number, total: number) => {
    if (!tty) return
    const width = 24
    const filled = total === 0 ? width : Math.round((completed / total) * width)
    stream.write(
      `\r  ${label} [${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${completed}/${total}`,
    )
    if (completed === total) stream.write('\n')
  }
}
