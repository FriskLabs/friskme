## What and why

<!-- What does this change, and why is it needed? Link the issue: Closes #N -->

## Checklist

- [ ] `bun run test`, `bun run typecheck` and `bun run biome:check` pass
- [ ] Tests use only the synthetic fixtures under `src/__fixtures__/`, with no real transcripts and no secret-shaped strings
- [ ] `README.md` is updated if flags, supported agents, what is sent/cached/downloaded, or detection thresholds changed
- [ ] `PROMPT_VERSION` is bumped if a prompt or schema changed
- [ ] No new network calls, and no lifecycle scripts added to `package.json`
