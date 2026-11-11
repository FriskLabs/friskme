# AGENTS.md

frisk is a Bun + TypeScript CLI. It reads Claude Code transcripts from `~/.claude/projects/**` (or `$CLAUDE_CONFIG_DIR/projects/**`) and writes a local report to `frisk-report/`: `report.html`, `report.json` and draft `skills/<intent>/SKILL.md` files. `README.md` is the user-facing spec. Read it before changing behavior.

## Commands

```sh
bun install
bun run test          # bun test --parallel src
bun run typecheck     # tsc --noEmit
bun run biome:check   # lint + format; applies fixes in place
bun run dev -- --no-llm
bun run build         # this platform's binary → dist/
bun run build:release # darwin-arm64, darwin-x64, linux-x64 → dist/
```

Before you call a change done, run `test`, `typecheck` and `biome:check`, and make sure all three pass.

## Layout

The pipeline runs in this order, all under `src/`:

- `cli.ts`: argument parsing, `HELP`, and the `cache` / `models` subcommands
- `scan.ts`: orchestration, confirmation prompts and writing the output files
- `discover.ts`, `parse/`: find transcripts and turn the JSONL into sessions
- `card/`: per-session cards for the model (`build-card.ts`) and redaction (`scrub-secrets.ts`)
- `llm/`: label pass → group pass → skill pass. `claude-runner.ts` spawns `claude -p`, `pool.ts` limits concurrency and `prompts.ts` holds the prompts, schemas and validators.
- `waste/`: deterministic waste detectors, plus `rate-table.ts` for dollar pricing
- `sensitive/`: secret and PII rules, validators, masking and the summary. `model/` holds the opt-in NER model (download, manifest, worker).
- `report/`: aggregation, terminal output, HTML, JSON and skill files
- `cache.ts`: the `~/.frisk/cache` store (`FRISK_CACHE_DIR` overrides it)
- `lib/`: three modules copied from the FriskAI monorepo. They no longer track the originals, so edit them freely.

## Invariants (do not break these)

- **Transcripts are read-only.** Never write, move or delete anything under the projects directory.
- **No network calls of frisk's own.** The only exceptions are `claude -p` and the opt-in `--pii-model` download. Every downloaded file is pinned by SHA-256 in `sensitive/model/manifest.ts`.
- **`claude -p` stays isolated.** Keep the flags in `llm/claude-runner.ts`: no tools, no MCP, no session persistence, an empty temp cwd and the prompt on stdin. Don't add `--bare`, which breaks subscription login. Every prompt starts with `FRISK_SENTINEL` (`constants.ts`), so frisk can skip its own sessions.
- **Cards carry only what README "What is sent where" lists.** That means no tool output, file contents, command lines, session ids or full paths. If you change what a card contains, update that README section too.
- **Redact before you cache or send.** Everything the sensitive scan finds is masked in a card before the card is cached or sent. A raw sensitive value never reaches the cache, the terminal or the report, unless the user passes `--reveal`. With `--reveal`, report files are written with mode 0600.
- **The model never computes numbers.** Counts, shares, tokens and dollars all come from code.
- **Bump `PROMPT_VERSION` (`llm/prompts.ts`) whenever a prompt or schema changes.** It is part of every cache key.
- **frisk is standalone.** No `@friskai/*` or `workspace:` dependencies, and no imports that reach outside the repo. `src/standalone.test.ts` enforces this.

## Tests

- Use `bun:test`, with `*.test.ts` files next to the code they test.
- Use only the synthetic fixtures in `src/__fixtures__/projects/`. Never use or commit real transcripts.
- Never commit a string shaped like a secret. Build fake secrets at runtime with `src/sensitive/test-secrets.ts`, so GitHub push protection doesn't block the push.
- Tests must never call the real `claude` CLI or the network. Inject a fake `SpawnFn` instead (see `src/llm/llm.test.ts`).

## Style

- Biome: 2-space indent, single quotes, no semicolons, imports organized.
- TypeScript is strict, with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. Use `import type` for type-only imports.
- Code is ESM. Relative imports include the `.ts` extension.

## Docs

Keep `README.md` in sync when you change:

- CLI flags (also update `HELP` in `cli.ts`)
- what is sent, cached or downloaded
- detection thresholds (the "How numbers are computed" section)
