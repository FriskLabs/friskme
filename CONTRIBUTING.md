# Contributing to friskme

Thanks for helping. Anyone can open an issue or a pull request. Maintainers review every PR, and only maintainers can merge.

## Before you start

- Read `README.md`. It is the user-facing spec, so a change in behavior usually means a README change too.
- Read `AGENTS.md`. It lists the layout, the commands and the invariants every change must keep. It applies to human contributors as much as to coding agents.
- For anything larger than a small fix, open an issue first so we can agree on the approach before you write code.

## Setup

You need [Bun](https://bun.sh) for development. friskme itself runs on Node 22.15 or newer.

```sh
bun install
bun run dev -- --no-llm
```

## Before you open a PR

All three must pass:

```sh
bun run test
bun run typecheck
bun run biome:check   # applies lint and format fixes in place
```

CI runs the same checks, then builds the Node bundle and smoke-tests it on Node 22.15. For PRs from forks, a maintainer has to approve the CI run before it starts.

## Rules that matter most

These come from `AGENTS.md`. PRs that break them won't be merged.

- **Transcripts are private.** Never commit a real Claude Code, Codex or Pi session, and never paste one or a `frisk-report/` file into an issue. Tests use only the synthetic fixtures under `src/__fixtures__/`.
- **No secret-shaped strings.** Build fake secrets at runtime with `src/sensitive/test-secrets.ts`.
- **No network in tests.** Tests never call the real `claude`, `codex` or `pi` CLI. Inject a fake `SpawnFn` (see `src/llm/llm.test.ts`).
- **No new network calls** in friskme, and no change to what a session card contains, unless the README "What is sent where" section is updated in the same PR.
- **Bump `PROMPT_VERSION`** (`src/llm/prompts.ts`) when a prompt or schema changes.
- **No lifecycle scripts** (`preinstall`, `postinstall` and so on) in `package.json`.

## Pull requests

- Keep each PR to one change, and explain why it's needed.
- Reference the issue (`Closes #N`).
- PRs are squash-merged, so the PR title becomes the commit message. Write it as a short imperative sentence.
- Changes to `.github/`, `scripts/` and `package.json` need extra review, because they run in CI and in the release pipeline.

## Reporting security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
