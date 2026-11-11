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
