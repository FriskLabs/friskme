# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue or PR for a security problem.

Please include the friskme version (`frisk --version`), how you installed it (npm or a release binary), your OS, and steps to reproduce. Don't attach real session transcripts or report files. If a reproduction needs one, build a synthetic one.

We aim to acknowledge reports within 3 business days and to keep you updated until the issue is fixed and disclosed.

## Supported versions

Only the latest release on npm (`friskme`) and GitHub Releases gets security fixes.

## What's in scope

friskme reads private coding-agent transcripts, so we especially want reports about:

- a raw secret or personal data reaching the cache, the terminal or the report without `--reveal`
- data sent to the analyzer beyond what README "What is sent where" lists
- the analyzer (`claude -p`, `codex exec`, `pi -p`) getting tools, MCP servers, network access or a working directory it shouldn't have
- friskme writing to, moving or deleting anything under an agent's sessions directory
- any network call by friskme other than the analyzer and the opt-in `--pii-model` download, or a download that isn't checked against its pinned SHA-256
- weaknesses in the build, CI or release pipeline
