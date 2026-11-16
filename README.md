# friskme

See what your coding-agent sessions were actually for. One command reads your last month of [Claude Code](https://claude.com/claude-code), [Codex](https://developers.openai.com/codex) and [Pi](https://pi.dev) sessions on your own machine and writes one report with:

- **Intents:** the plain-language jobs behind your sessions and their share of your time.
- **Repeated workflows:** jobs you keep doing the same way, each with a draft `SKILL.md` you can review and install.
- **Waste:** loops that kept failing, the same command run over and over, error streaks, and sessions you abandoned mid-turn, each priced in tokens and dollars.
- **Sensitive data:** secrets and personal data that surfaced in your sessions (an API key printed by `cat .env`, an email in a tool's output), masked, with what to rotate.

No account and no sign-up. friskme makes no network calls of its own, except one opt-in download: the PII model, with `--pii-model`.

## Install

Run it with npx. You need Node 22.15 or newer, and you don't need Bun:

```sh
npx friskme
```

To install the `friskme` command, run `npm i -g friskme`.

The npm package is one JavaScript file of about 1 MB, with no dependencies and nothing to compile. npm downloads it at install time; friskme itself downloads nothing. It's tested on macOS and Linux. It should also run on Windows and on Alpine and other musl-based Linux distributions, but those aren't tested. On Windows, the analyzer must be a native `claude.exe`, `codex.exe` or `pi.exe`, not an npm `.cmd` shim. `--pii-model` works only on macOS (Apple silicon or Intel) and Linux x64.

If you don't have Node, download a standalone binary (about 70–90 MB) from [GitHub Releases](https://github.com/FriskLabs/friskme/releases) and put it on your `PATH`. Each release includes a `SHA256SUMS` file.

| Platform             | File                 |
| -------------------- | -------------------- |
| macOS, Apple silicon | `frisk-darwin-arm64` |
| macOS, Intel         | `frisk-darwin-x64`   |
| Linux x64            | `frisk-linux-x64`    |
| Linux arm64          | `frisk-linux-arm64`  |

```sh
chmod +x frisk-darwin-arm64 && mv frisk-darwin-arm64 /usr/local/bin/friskme
```

To build from this repo, run `bun run build:release`. That writes all four binaries to `dist/`; `build` compiles only your own platform, and `build:npm` writes the Node bundle to `dist/frisk.js`.

Naming intents and drafting skills needs one model CLI, logged in: `claude` (Claude Code), `codex` or `pi`. friskme uses `claude` or `codex`, whichever you have, Claude first; `--analyzer` picks one. `pi` is used only with `--analyzer pi`, because its default model is whatever you chat with, which can cost far more per call than a small labeling model. Without either, run `friskme --no-llm` to get the overview and waste sections only.

## Use

```sh
friskme                       # last 30 days, every agent found; asks before any model call
friskme --agent codex         # only Codex sessions
friskme --agent claude,pi     # only Claude Code and Pi sessions
friskme --analyzer codex      # label with codex exec instead of claude -p
friskme --analyzer pi --model claude-haiku-5-5  # label with pi -p
friskme --yes --since 2w      # no prompt, last two weeks
friskme --project my-repo     # only sessions whose project path contains "my-repo"
friskme --no-llm              # deterministic sections only, nothing sent anywhere
friskme --json > report.json  # machine-readable; the summary goes to stderr
```

Other options:

- `--agent claude,codex,pi`: which agents to read (default: every agent whose session folder exists)
- `--analyzer claude|codex|pi`: which CLI names intents (default: `claude` if logged in, else `codex`; `pi` only when asked)
- `--max-sessions <n>`
- `--model <name>`: the analyzer's model (default `haiku` for `claude`; Codex's own default for `codex`; pi's default model for `pi`, which accepts `provider/id` and a `:<thinking>` suffix)
- `--out <dir>` (default `./frisk-report`)
- `--no-sensitive`: skip the secrets and personal-data scan
- `--pii-model`, `--pii-model-scope prompts|all`: see [Sensitive data](#sensitive-data)
- `--reveal`: show secrets and personal data unmasked in the report (see below)
- `friskme cache clear`
- `friskme models list|download|remove`

While it runs, friskme keeps one live status line on stderr: what it is doing now, progress counts and time spent in that step. The line animates only in an interactive terminal. When stderr is piped, under `CI`, or with `TERM=dumb`, friskme prints only its plain log lines.

Output:

- `frisk-report/report.html`: one self-contained page, with no external assets.
- `frisk-report/report.json`: the same data.
- `frisk-report/skills/<intent>/SKILL.md`: draft skills. friskme never installs them. Read one, edit it, then copy it to `~/.claude/skills/<name>/SKILL.md` (Claude Code) `~/.codex/skills/<name>/SKILL.md` (Codex) or `~/.pi/agent/skills/<name>/SKILL.md` (Pi) if you want it.

## What is read

| Agent       | Folder                                                                                       | Files                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/projects/`, or `$CLAUDE_CONFIG_DIR/projects/`                                     | session transcripts (`<project>/<session>.jsonl`) and subagent runs (`<project>/<session>/subagents/*.jsonl`)                                                                                                                      |
| Codex       | `~/.codex/sessions/`, or `$CODEX_HOME/sessions/`                                             | rollouts (`YYYY/MM/DD/rollout-*.jsonl`, or `.jsonl.zst` compressed, which friskme decompresses in memory). A rollout spawned by another session (`spawn_agent`) is counted as that session's subagent run.                         |
| Pi          | `~/.pi/agent/sessions/`, `$PI_CODING_AGENT_DIR/sessions/`, or `$PI_CODING_AGENT_SESSION_DIR` | session files (`--<folder>--/<time>_<id>.jsonl`). Every branch in a file counts. A session made with `/fork` or `/clone` copies its parent's history; friskme counts only what was added after the copy. Pi has no subagent files. |

By default friskme reads every agent whose folder exists; `--agent` narrows it down. Every agent's sessions go into one report, each tagged with its agent, with sessions, tokens and dollars broken down per agent.

The access is strictly read-only: friskme lists directories and reads files, and never writes, moves or deletes anything there.

To tell which repo a session belongs to, friskme also reads one small file outside these folders: the `.git` file in the session's working directory, if there is one. A git worktree's `.git` file points at its main repo, so sessions in worktrees count under that repo instead of showing up as projects of their own.

Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default), so about a month of history is the most there is.

## What is sent where

Unless you pass `--no-llm`, friskme runs one analyzer CLI: `claude -p` (calls go to Anthropic under your own Claude login), `codex exec` (calls go to OpenAI under your own Codex login) or `pi -p` (calls go to the provider of the model pi uses, under your own pi login for that provider). Any analyzer labels sessions from every agent, so with `--analyzer codex` your Claude Code and Pi cards go to OpenAI, and with `claude` your Codex and Pi cards go to Anthropic. Nothing goes anywhere else: no telemetry, and no FriskAI endpoint.

friskme shows you the planned number of calls and asks before making any. It makes three kinds of call:

1. **Labeling:** batches of up to 30 session cards. A card holds:
   - the first prompt you typed, cut to 600 characters
   - up to 5 follow-ups, 200 characters each
   - the project folder's name (not its path)
   - tool names with coarse details (`Bash:git`, `Edit:ts`, `exec_command:package_manager`, `apply_patch:ts`, `bash:git`, `edit:ts`, `mcp:github`)
   - error and interrupt counts

   It never includes tool output, file contents, command lines or session ids.
2. **Grouping:** only the short labels from step 1 and their counts.
3. **Skill drafting:** 3 to 5 of the same cards, for each repeated workflow.

Before a card is cached or sent, friskme redacts everything the sensitive-data scan finds (secrets and personal data, see below), plus bearer tokens, `.env`-style `*_KEY=`/`*_SECRET=`/`*_PASSWORD=` lines and long random strings. The report's "Method and caveats" section lists how many of each it redacted.

Every `claude -p` call runs isolated:

```
claude -p --no-session-persistence --safe-mode --strict-mcp-config \
  --tools "" --disallowedTools "mcp__*" --max-turns 1 \
  --system-prompt <friskme's> --output-format json --json-schema <schema> --model haiku
```

It runs from an empty temp directory, with the prompt on stdin. These flags mean:

- **No transcripts left behind:** friskme's calls don't add sessions to the folder it reads.
- **Nothing to act with:** the model has no tools, so it cannot act on anything written in your transcripts.
- **No customizations:** your hooks, CLAUDE.md, plugins and MCP servers are not loaded.

`--bare` is not used because it does not work with subscription login.

Every `codex exec` call runs as isolated as Codex allows:

```
codex exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check \
  --sandbox read-only --color never --cd <empty temp dir> \
  -c approval_policy="never" -c web_search="disabled" -c project_doc_max_bytes=0 \
  -c history.persistence="none" -c features.shell_tool=false -c features.multi_agent=false \
  -c features.apps=false -c features.view_image=false -c features.memories=false \
  --output-schema <schema file> --output-last-message <answer file> [--model <name>] -
```

- **No rollouts left behind:** `--ephemeral` writes no session to the folder friskme reads, and history is off.
- **Nothing to act with:** web search, the shell tool, subagents, apps and image viewing are off. Codex has no switch that removes every built-in tool, so a read-only sandbox, no approvals and an empty working folder back that up.
- **No customizations:** your `config.toml` (MCP servers, plugins, profiles), execpolicy rules and AGENTS.md are not loaded. Your login still is.
- `codex exec` has no system-prompt flag, so friskme's instructions go at the top of the prompt on stdin. The schema and answer files are written to a separate temp folder and deleted after each call.
- `codex exec` does not report cost, so the report says friskme's own calls are unpriced.

Every `pi -p` call runs isolated:

```
PI_TELEMETRY=0 PI_OFFLINE=1 pi --print --mode json --no-session --no-tools \
  --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-approve --offline \
  --system-prompt <friskme's> --thinking off [--model <name>]
```

It runs from an empty temp directory, with the prompt on stdin. These flags mean:

- **No sessions left behind:** `--no-session` keeps the session in memory, so nothing lands in the folder friskme reads.
- **Nothing to act with:** `--no-tools` turns off every built-in, extension and MCP tool.
- **No customizations:** your extensions, MCP servers, skills, prompt templates and AGENTS.md/CLAUDE.md are not loaded, and trust-gated project files are ignored. Your provider login still is.
- **Only the model call goes out:** `--offline` and `PI_TELEMETRY=0` turn off pi's model-catalog refresh, version check and install telemetry.
- **Thinking off:** labeling doesn't need it. Name a level in the model (`--model sonnet:low`) to keep one.
- pi has no structured-output flag, so the JSON schema goes at the end of the prompt, and friskme checks every answer against it, retrying once.
- pi reports what each call cost, so the report prices friskme's own calls.
- Before the first call, friskme runs `pi auth check` for the provider in `--model` (`provider/id`), or else for the `defaultProvider` in pi's `settings.json`. That one field is all friskme reads from pi's config.

A typical month (about 50 sessions) takes 3 to 7 calls, a few cents on Haiku at API list price.

## What is cached where

`~/.frisk/cache/` (set `FRISK_CACHE_DIR` to move it) holds:

- `labels/<session-id>.<hash>.json`: one label per session.
- `groups/<hash>.json`: the intent grouping.
- `skills/<hash>.json`: skill drafts.
- `pii-ner/<hash>.json`: with `--pii-model`, the masked entities found in each chunk of text (type, masked value, fingerprint).

Each entry is keyed by a hash of exactly what was sent, plus the analyzer, model and prompt version. A re-run therefore only labels new or changed sessions. The cache holds model outputs only, never transcript text and never a raw sensitive value.

To delete it:

```sh
friskme cache clear   # or: rm -rf ~/.frisk
friskme models remove # the PII model, if you downloaded it
```

## Sensitive data

Every scan checks all the text in your sessions for secrets and personal data:

- what you typed
- tool input and output
- the agent's replies
- subagent runs

On a month of history (about 95M characters) this takes a few seconds. It runs locally, and nothing is sent anywhere for it.

**Rules (always on):**

- **Secrets:** about 45 provider rules derived from the [gitleaks](https://github.com/gitleaks/gitleaks) defaults (MIT), including AWS, Google, Azure, GitHub, GitLab, Slack, Stripe, OpenAI, Anthropic, Hugging Face, npm, Linear, Vault, private keys, JWTs and credentials in URLs. Placeholders, doc examples and local dev passwords (`postgres:postgres@localhost`) are ignored.
- **Personal data:** recognizers modeled on [Presidio](https://github.com/microsoft/presidio)'s (MIT), each with a validator:
  - emails
  - credit cards (Luhn checked; published test cards are ignored)
  - IBANs (mod-97)
  - US SSNs (only with a context word)
  - phone numbers (formatted, or with a context word)
  - public IP addresses
  - crypto wallets

**`--pii-model` (opt-in):** names and places need a model, so friskme can also run [`bert-base-NER`](https://huggingface.co/dslim/bert-base-NER) (MIT) on your machine.

- **Download:** the first run asks before downloading about 190 MB. Most of it is the model (109 MB, from huggingface.co); the rest is the ONNX Runtime package from registry.npmjs.org, of which only your platform's library (~30 MB) and its Node binding (~0.3 MB) are kept. It's available on macOS (Apple silicon or Intel) and Linux x64. Every file is checked against a SHA-256 pinned in friskme, and a mismatch deletes the file and stops. It installs into `~/.frisk/models` (set `FRISK_MODELS_DIR` to move it), and later runs work offline.
- **Scope and speed:** by default it reads what you typed and the agent's replies, about 1.3M characters, in under a minute (roughly 6k tokens/s on an Apple M-series laptop). `--pii-model-scope all` adds tool input and output and subagents; that can take tens of minutes on a month of history. Results are cached per chunk, so re-runs only scan new text.
- **What it reports:** names with two or more words, at high confidence. Places are listed in report.json only.
- **Effect on the analyzer:** names it finds are also masked in the cards sent for labeling.
- **Management:** `friskme models list` shows the size and verifies every hash; `friskme models remove` deletes the model.

**What the report shows:**

- Values are always masked: `ghp_…(40)`, `j•••@a•••.io`, `•••• 1486`, `J. D.`.
- Each value has a salted fingerprint, so repeats are counted without being stored. The salt is random per install, in `~/.frisk/salt`.
- By default, no raw value is written to report.html, report.json, the cache or the terminal.
- **`--reveal`** shows the real values in report.html and report.json, so you can check each finding:
  - Both files are written readable by you only (0600).
  - The report opens with a warning not to share it, and the terminal says so too.
  - Raw values still never go into the cache: names the model found earlier are recovered from the text being scanned, by matching fingerprints.
- Low-confidence matches (generic `key = …` assignments, bare IPs, places) are listed in report.json only.

A secret listed under **Rotate** appeared in a session, so it was sent to the model provider with the rest of that conversation. Treat it as exposed.

## How numbers are computed

All counts, shares and costs are computed by friskme, not by the model.

- **Shares** never round a part to 100% or a nonzero value to 0%.
- **Tokens** count each API response once, including cache reads and writes and subagent runs.
  - **Claude Code** logs one usage record per response, repeated on each line of that response; friskme keeps one per `message.id`.
  - **Codex** logs cumulative `token_count` events, often repeated unchanged; friskme counts the per-response `last_token_usage` only when the cumulative total changes. Newer Codex builds also log `token_usage_record` per `response_id`; when a rollout has those, friskme uses them instead. Codex counts cached tokens inside `input_tokens` (the OpenAI convention), so friskme splits them out: input is `input_tokens − cached_input_tokens − cache_write_input_tokens`, cached tokens are cache reads, and reasoning tokens are already inside output.
  - **Pi** logs usage on each assistant message, already split the Anthropic way (input excludes cache reads and writes) for every provider; friskme keeps one per `responseId`. `cacheWrite1h` is the 1-hour part of `cacheWrite` and the rest is priced as a 5-minute write. friskme also counts `usage` entries (cache warming), and the usage logged on compactions, branch summaries and tool results. A model id with a provider prefix (`anthropic/claude-…`) is priced by the part after the slash. Pi's own `cost` field is not used.
- **Dollars** are labeled _API list-price equivalent_, using a rate table bundled with friskme and dated in the report: Anthropic's for Claude models and OpenAI's (standard tier, short context) for GPT models. Codex-specific models OpenAI no longer lists (`gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.2-codex`) are priced as the base model they shipped with. Models without a rate are named and left out of dollar totals. Most people are on a subscription and do not pay this.
- **Waste detection** is deterministic:
  - A _loop_ is a tool pattern repeated 3+ times in a row where at least 2 iterations, and at least half of them, failed.
  - _Repeated commands_ are the same shell command (`Bash` in Claude Code; `exec_command`, `shell` and `shell_command` in Codex; `bash` in Pi) 3+ times in a session. `sleep` polling is excluded.
  - An _error streak_ is 3+ failed tool calls in a row. A Codex tool call failed when its output reports a non-zero exit code; a Pi tool call failed when its result has `isError`.
  - An _interrupted ending_ is a session that ended right after you interrupted the agent.
- **Projects** are the repo a session ran in. A git worktree counts under its main repo: friskme follows the worktree's `.git` file, or, if the worktree is gone, recognizes `<repo>/.claude/worktrees/<name>`, `<repo>/.worktrees/<name>` and `superpowers/worktrees/<repo>/<name>`. Any other folder is its own project.
- **A repeated workflow** is 4+ sessions in one intent whose tool mix has cosine similarity ≥ 0.8 with the most typical one.

## Development

```sh
bun install
bun run test        # synthetic fixtures only; never real transcripts
bun run typecheck
bun run biome:check
bun run dev -- --no-llm
```

friskme is self-contained: it has no workspace dependencies, and `src/standalone.test.ts` fails if one is added.

To add an agent, see "Adding an agent" in `AGENTS.md`. To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately, as described in [SECURITY.md](SECURITY.md).

### Releasing

friskme is published to npm as one package holding `dist/frisk.js`: friskme and its dependencies, bundled for Node by `scripts/bundle.ts`. The compiled binaries go to GitHub Releases only. To release:

1. Set the same version in `package.json` and `FRISK_VERSION` (`src/constants.ts`), and merge that through a PR.
2. Push a tag from the merged `main`: `git tag v0.1.0 && git push origin v0.1.0`. Only maintainers can push `v*` tags.
3. Approve the run's `release` environment deployment in the Actions tab.

`.github/workflows/release.yml` runs the checks, builds every binary and the Node bundle, lays out the package with `scripts/pack-npm.ts`, installs it and runs `scripts/smoke.sh` against it, publishes to npm, and creates a GitHub Release that has the binaries and `SHA256SUMS`. It publishes through npm trusted publishing (OIDC), so no npm token is stored: `friskme` on npmjs.com trusts the `FriskLabs/friskme` repository's `release.yml` workflow, and every version carries npm provenance.
