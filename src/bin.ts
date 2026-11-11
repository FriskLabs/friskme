#!/usr/bin/env bun
/**
 * The executable entry point: the npm bundle, the compiled binaries and
 * `bun run dev` all start here. `cli.ts` only exports `main`, so tests can
 * import it without running anything. It is imported after the runtime check,
 * so an old Node gets a clear message instead of a load error.
 */
import { runtimeProblem } from './runtime-check.ts'

const problem = runtimeProblem()
if (problem) {
  process.stderr.write(`${problem}\n`)
  process.exit(1)
}

const { main } = await import('./cli.ts')
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `frisk failed: ${err instanceof Error ? err.stack : String(err)}\n`,
    )
    process.exit(1)
  },
)
