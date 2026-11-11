# AGENTS.md

frisk is a Bun + TypeScript CLI. It reads coding-agent sessions (Claude Code from `~/.claude/projects/**` or `$CLAUDE_CONFIG_DIR/projects/**`; Codex from `~/.codex/sessions/**` or `$CODEX_HOME/sessions/**`) and writes one local report to `frisk-report/`: `report.html`, `report.json` and draft `skills/<intent>/SKILL.md` files. `README.md` is the user-facing spec. Read it before changing behavior.

## Commands

```sh
bun install
bun run test          # bun test --parallel src
bun run typecheck     # tsc --noEmit
bun run biome:check   # lint + format; applies fixes in place
bun run dev -- --no-llm
bun run build         # this platform's binary → dist/
bun run build:release # darwin-arm64, darwin-x64, linux-x64, linux-arm64 → dist/
bun run pack:npm -- <version> # npm packages from dist/ → dist/npm/
```

Before you call a change done, run `test`, `typecheck` and `biome:check`, and make sure all three pass.

## Layout

The pipeline runs in this order, all under `src/`:

- `cli.ts`: argument parsing, `HELP`, and the `cache` / `models` subcommands
- `scan.ts`: orchestration, confirmation prompts and writing the output files
- `agents/`: one adapter per agent (`claude/`, `codex/`), each implementing `AgentSource` (`agents/types.ts`): find session files, fold one into the agent-neutral `Session`, read subagent usage. `registry.ts` lists them and resolves `--agent`.
- `discover.ts`: `loadSessions`, which reads every source and applies the window, `--project` and `--max-sessions` filters
- `parse/`: helpers shared by adapters (JSONL reading, `emptySession`/`finishSession`, step keys)
- `card/`: per-session cards for the model (`build-card.ts`) and redaction (`scrub-secrets.ts`)
- `llm/`: label pass → group pass → skill pass, against the `ModelRunner` interface (`runner.ts`). `claude-runner.ts` spawns `claude -p`, `codex-runner.ts` spawns `codex exec`, `preflight.ts` picks the analyzer, `pool.ts` limits concurrency and `prompts.ts` holds the prompts, schemas and validators.
- `waste/`: deterministic waste detectors, plus `rate-table.ts` for dollar pricing
- `sensitive/`: secret and PII rules, validators, masking and the summary. `model/` holds the opt-in NER model (download, manifest, worker).
- `report/`: aggregation, terminal output, HTML, JSON and skill files
- `cache.ts`: the `~/.frisk/cache` store (`FRISK_CACHE_DIR` overrides it)
- `lib/`: three modules copied from the FriskAI monorepo. They no longer track the originals, so edit them freely.

Release tooling sits outside `src/`:

- `scripts/targets.ts`: the platforms that are shipped. `compile.ts` builds them, and `npm-manifest.ts` and `pack-npm.ts` turn them into the npm packages.
- `npm/launcher/frisk.js`: the plain-Node `bin` of the `friskme` npm package. It finds the `friskme-<os>-<arch>` package and runs its binary.
- `.github/workflows/`: `ci.yml` checks PRs, and `release.yml` publishes on a `v*` tag (see README "Releasing").

## Invariants (do not break these)

- **Transcripts are read-only.** Never write, move or delete anything under the projects directory.
- **No network calls of frisk's own.** The only exceptions are the analyzer (`claude -p` or `codex exec`) and the opt-in `--pii-model` download. Every downloaded file is pinned by SHA-256 in `sensitive/model/manifest.ts`.
- **The analyzer stays isolated.** Keep the flags in `llm/claude-runner.ts`: no tools, no MCP, no session persistence, an empty temp cwd and the prompt on stdin. Don't add `--bare`, which breaks subscription login. Keep the flags in `llm/codex-runner.ts`: `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, read-only sandbox, no approvals, web search/shell/multi-agent/apps off, no AGENTS.md, an empty temp cwd and the prompt on stdin. Every prompt starts with `FRISK_SENTINEL` (`constants.ts`), and every adapter drops sessions that start with it, so frisk can skip its own sessions.
- **Cards carry only what README "What is sent where" lists.** That means no tool output, file contents, command lines, session ids or full paths. If you change what a card contains, update that README section too.
- **Redact before you cache or send.** Everything the sensitive scan finds is masked in a card before the card is cached or sent. A raw sensitive value never reaches the cache, the terminal or the report, unless the user passes `--reveal`. With `--reveal`, report files are written with mode 0600.
- **The model never computes numbers.** Counts, shares, tokens and dollars all come from code.
- **Bump `PROMPT_VERSION` (`llm/prompts.ts`) whenever a prompt or schema changes.** It is part of every cache key.
- **frisk is standalone.** No `@friskai/*` or `workspace:` dependencies, and no imports that reach outside the repo. `src/standalone.test.ts` enforces this.

## Tests

- Use `bun:test`, with `*.test.ts` files next to the code they test.
- Use only the synthetic fixtures in `src/__fixtures__/projects/` (Claude Code) and `src/__fixtures__/codex/sessions/` (Codex). Never use or commit real transcripts or rollouts. Compressed (`.zst`) variants are made at test time with `Bun.zstdCompressSync`.
- Never commit a string shaped like a secret. Build fake secrets at runtime with `src/sensitive/test-secrets.ts`, so GitHub push protection doesn't block the push.
- Tests must never call the real `claude` or `codex` CLI or the network. Inject a fake `SpawnFn` instead (see `src/llm/llm.test.ts`).

## Style

- Biome: 2-space indent, single quotes, no semicolons, imports organized.
- TypeScript is strict, with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. Use `import type` for type-only imports.
- Code is ESM. Relative imports include the `.ts` extension.

## Adding an agent

1. Add `src/agents/<id>/` with an `AgentSource`: `defaultRoot` (honor the agent's own env override), a read-only `discover`, `parse` (build with `emptySession(id, '<id>')`, finish with `finishSession`, which drops prompt-less and frisk-made sessions) and `parseSubagent`.
2. Map the agent's tool names onto `ToolKind` (`shell`, `edit`, `read`, `subagent`, `mcp`, `plan`, `other`) and keep `detail` coarse: a command family, a file extension, an MCP server. Waste detectors match on `kind`, never on tool names. Fill `bashRuns` for shell commands.
3. Only typed prompts count. Drop text the agent injected (context blocks, instruction files, notifications).
4. Normalize usage into `TokenTotals` (input excludes cache reads and writes) and key `messageUsage` by response so each response is counted once. Give every `ToolStep` the `messageId` of the response that made it.
5. Add the id to `AGENT_IDS` (`types.ts`) and the source to `ALL_AGENTS` (`agents/registry.ts`).
6. Add the agent's model rates to `waste/rate-table.ts`, with an as-of date.
7. Add synthetic fixtures and tests next to the adapter.
8. Update README: "What is read", the card example under "What is sent where", and "How numbers are computed".

## Workflow

- Track work in GitHub issues on `FriskLabs/frisk-cli`. Reference the issue in commits (`Refs #N`) and close it from the PR (`Closes #N`).
- To release, follow README "Releasing": keep `package.json` `version` and `FRISK_VERSION` equal, then push a `v<version>` tag. Never publish to npm by hand.
- Don't add AI attribution to commits or PRs: no `Co-Authored-By` trailer for an assistant, and no "Generated with …" line.

## Docs

Keep `README.md` in sync when you change:

- CLI flags (also update `HELP` in `cli.ts`)
- supported agents, their folders, or how their sessions are parsed
- what is sent, cached or downloaded
- detection thresholds (the "How numbers are computed" section)
