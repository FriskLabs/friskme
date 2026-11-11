# Frisk CLI

See what your coding-agent sessions were actually for. One command reads your last month of [Claude Code](https://claude.com/claude-code) and [Codex](https://developers.openai.com/codex) sessions on your own machine and writes one report with:

- **Intents:** the plain-language jobs behind your sessions and their share of your time.
- **Repeated workflows:** jobs you keep doing the same way, each with a draft `SKILL.md` you can review and install.
- **Waste:** loops that kept failing, the same command run over and over, error streaks, and sessions you abandoned mid-turn, each priced in tokens and dollars.
- **Sensitive data:** secrets and personal data that surfaced in your sessions (an API key printed by `cat .env`, an email in a tool's output), masked, with what to rotate.

No account and no sign-up. frisk makes no network calls of its own, except one opt-in download: the PII model, with `--pii-model`.

## Install

Download the binary for your platform and put it on your `PATH`. You don't need Bun.

| Platform             | File                 |
| -------------------- | -------------------- |
| macOS, Apple silicon | `frisk-darwin-arm64` |
| macOS, Intel         | `frisk-darwin-x64`   |
| Linux x64            | `frisk-linux-x64`    |

```sh
chmod +x frisk-darwin-arm64 && mv frisk-darwin-arm64 /usr/local/bin/frisk
```

To build from this repo, run `bun run build:release`. That writes all three binaries to `dist/`; `build` compiles only your own platform.

Naming intents and drafting skills needs one model CLI, logged in: `claude` (Claude Code) or `codex`. frisk uses whichever you have, Claude first; `--analyzer` picks one. Without either, run `frisk --no-llm` to get the overview and waste sections only.

## Use

```sh
frisk                       # last 30 days, every agent found; asks before any model call
frisk --agent codex         # only Codex sessions
frisk --analyzer codex      # label with codex exec instead of claude -p
frisk --yes --since 2w      # no prompt, last two weeks
frisk --project my-repo     # only sessions whose working directory contains "my-repo"
frisk --no-llm              # deterministic sections only, nothing sent anywhere
frisk --json > report.json  # machine-readable; the summary goes to stderr
```

Other options:

- `--agent claude,codex`: which agents to read (default: every agent whose session folder exists)
- `--analyzer claude|codex`: which CLI names intents (default: `claude` if logged in, else `codex`)
- `--max-sessions <n>`
- `--model <name>`: the analyzer's model (default `haiku` for `claude`; Codex's own default for `codex`)
- `--out <dir>` (default `./frisk-report`)
- `--no-sensitive`: skip the secrets and personal-data scan
- `--pii-model`, `--pii-model-scope prompts|all`: see [Sensitive data](#sensitive-data)
- `--reveal`: show secrets and personal data unmasked in the report (see below)
- `frisk cache clear`
- `frisk models list|download|remove`

Output:

- `frisk-report/report.html`: one self-contained page, with no external assets.
- `frisk-report/report.json`: the same data.
- `frisk-report/skills/<intent>/SKILL.md`: draft skills. frisk never installs them. Read one, edit it, then copy it to `~/.claude/skills/<name>/SKILL.md` (Claude Code) or `~/.codex/skills/<name>/SKILL.md` (Codex) if you want it.

## What is read

| Agent       | Folder                                                   | Files                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/projects/`, or `$CLAUDE_CONFIG_DIR/projects/` | session transcripts (`<project>/<session>.jsonl`) and subagent runs (`<project>/<session>/subagents/*.jsonl`)                                                                                            |
| Codex       | `~/.codex/sessions/`, or `$CODEX_HOME/sessions/`         | rollouts (`YYYY/MM/DD/rollout-*.jsonl`, or `.jsonl.zst` compressed, which frisk decompresses in memory). A rollout spawned by another session (`spawn_agent`) is counted as that session's subagent run. |

By default frisk reads every agent whose folder exists; `--agent` narrows it down. Both agents' sessions go into one report, each tagged with its agent, with sessions, tokens and dollars broken down per agent.

The access is strictly read-only: frisk lists directories and reads files, and never writes, moves or deletes anything there.

Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default), so about a month of history is the most there is.

## What is sent where

Unless you pass `--no-llm`, frisk runs one analyzer CLI: `claude -p` (calls go to Anthropic under your own Claude login) or `codex exec` (calls go to OpenAI under your own Codex login). Either analyzer labels sessions from both agents, so with `--analyzer codex` your Claude Code cards go to OpenAI, and with `claude` your Codex cards go to Anthropic. Nothing goes anywhere else: no telemetry, and no FriskAI endpoint.

frisk shows you the planned number of calls and asks before making any. It makes three kinds of call:

1. **Labeling:** batches of up to 30 session cards. A card holds:
   - the first prompt you typed, cut to 600 characters
   - up to 5 follow-ups, 200 characters each
   - the project folder's name (not its path)
   - tool names with coarse details (`Bash:git`, `Edit:ts`, `exec_command:package_manager`, `apply_patch:ts`, `mcp:github`)
   - error and interrupt counts

   It never includes tool output, file contents, command lines or session ids.
2. **Grouping:** only the short labels from step 1 and their counts.
3. **Skill drafting:** 3 to 5 of the same cards, for each repeated workflow.

Before a card is cached or sent, frisk redacts everything the sensitive-data scan finds (secrets and personal data, see below), plus bearer tokens, `.env`-style `*_KEY=`/`*_SECRET=`/`*_PASSWORD=` lines and long random strings. The report's "Method and caveats" section lists how many of each it redacted.

Every `claude -p` call runs isolated:

```
claude -p --no-session-persistence --safe-mode --strict-mcp-config \
  --tools "" --disallowedTools "mcp__*" --max-turns 1 \
  --system-prompt <frisk's> --output-format json --json-schema <schema> --model haiku
```

It runs from an empty temp directory, with the prompt on stdin. These flags mean:

- **No transcripts left behind:** frisk's calls don't add sessions to the folder it reads.
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

- **No rollouts left behind:** `--ephemeral` writes no session to the folder frisk reads, and history is off.
- **Nothing to act with:** web search, the shell tool, subagents, apps and image viewing are off. Codex has no switch that removes every built-in tool, so a read-only sandbox, no approvals and an empty working folder back that up.
- **No customizations:** your `config.toml` (MCP servers, plugins, profiles), execpolicy rules and AGENTS.md are not loaded. Your login still is.
- `codex exec` has no system-prompt flag, so frisk's instructions go at the top of the prompt on stdin. The schema and answer files are written to a separate temp folder and deleted after each call.
- `codex exec` does not report cost, so the report says frisk's own calls are unpriced.

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
frisk cache clear   # or: rm -rf ~/.frisk
frisk models remove # the PII model, if you downloaded it
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

**`--pii-model` (opt-in):** names and places need a model, so frisk can also run [`bert-base-NER`](https://huggingface.co/dslim/bert-base-NER) (MIT) on your machine.

- **Download:** the first run asks before downloading about 190 MB. Most of it is the model (109 MB, from huggingface.co); the rest is the ONNX Runtime package from registry.npmjs.org, of which only your platform's library (~30 MB) is kept. Every file is checked against a SHA-256 pinned in frisk, and a mismatch deletes the file and stops. It installs into `~/.frisk/models` (set `FRISK_MODELS_DIR` to move it), and later runs work offline.
- **Scope and speed:** by default it reads what you typed and the agent's replies, about 1.3M characters, in under a minute (roughly 6k tokens/s on an Apple M-series laptop). `--pii-model-scope all` adds tool input and output and subagents; that can take tens of minutes on a month of history. Results are cached per chunk, so re-runs only scan new text.
- **What it reports:** names with two or more words, at high confidence. Places are listed in report.json only.
- **Effect on the analyzer:** names it finds are also masked in the cards sent for labeling.
- **Management:** `frisk models list` shows the size and verifies every hash; `frisk models remove` deletes the model.

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

All counts, shares and costs are computed by frisk, not by the model.

- **Shares** never round a part to 100% or a nonzero value to 0%.
- **Tokens** count each API response once, including cache reads and writes and subagent runs.
  - **Claude Code** logs one usage record per response, repeated on each line of that response; frisk keeps one per `message.id`.
  - **Codex** logs cumulative `token_count` events, often repeated unchanged; frisk counts the per-response `last_token_usage` only when the cumulative total changes. Newer Codex builds also log `token_usage_record` per `response_id`; when a rollout has those, frisk uses them instead. Codex counts cached tokens inside `input_tokens` (the OpenAI convention), so frisk splits them out: input is `input_tokens − cached_input_tokens − cache_write_input_tokens`, cached tokens are cache reads, and reasoning tokens are already inside output.
- **Dollars** are labeled _API list-price equivalent_, using a rate table bundled with frisk and dated in the report: Anthropic's for Claude models and OpenAI's (standard tier, short context) for GPT models. Codex-specific models OpenAI no longer lists (`gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.2-codex`) are priced as the base model they shipped with. Models without a rate are named and left out of dollar totals. Most people are on a subscription and do not pay this.
- **Waste detection** is deterministic:
  - A _loop_ is a tool pattern repeated 3+ times in a row where at least 2 iterations, and at least half of them, failed.
  - _Repeated commands_ are the same shell command (`Bash` in Claude Code; `exec_command`, `shell` and `shell_command` in Codex) 3+ times in a session. `sleep` polling is excluded.
  - An _error streak_ is 3+ failed tool calls in a row. A Codex tool call failed when its output reports a non-zero exit code.
  - An _interrupted ending_ is a session that ended right after you interrupted the agent.
- **A repeated workflow** is 4+ sessions in one intent whose tool mix has cosine similarity ≥ 0.8 with the most typical one.

## Development

```sh
bun install
bun run test        # synthetic fixtures only; never real transcripts
bun run typecheck
bun run biome:check
bun run dev -- --no-llm
```

frisk is self-contained: it uses no FriskAI workspace packages, and `src/standalone.test.ts` fails if one is imported.

To add an agent, see "Adding an agent" in `AGENTS.md`.

`src/lib/` holds three modules copied from FriskAI's control-plane monorepo on 2026-11-11: `sequence-fold.ts` (the loop fold), `command-family.ts` (Bash command families) and `mcp-tool-name.ts`. They no longer track the originals.
