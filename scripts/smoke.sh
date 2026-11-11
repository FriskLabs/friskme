#!/usr/bin/env bash
# Runs a built frisk against the synthetic fixtures, without the model, and
# checks the report. One Codex rollout is zstd-compressed first, so reading
# `.jsonl.zst` is exercised too.
#
#   scripts/smoke.sh node dist/frisk.js
#   scripts/smoke.sh npx --no-install frisk
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/codex"
cp -R "$repo/src/__fixtures__/codex/sessions" "$work/codex/"
first="$(find "$work/codex/sessions" -name '*.jsonl' | sort | head -n 1)"
zstd -q --rm "$first"

CLAUDE_CONFIG_DIR="$repo/src/__fixtures__" \
  CODEX_HOME="$work/codex" \
  FRISK_CACHE_DIR="$work/cache" \
  "$@" --no-llm --yes --since 2020-01-01 --out "$work/report"

sessions="$(node -p "require('$work/report/report.json').overview.sessions")"
if [ "$sessions" != 5 ]; then
  echo "smoke: expected 5 sessions in report.json, got $sessions" >&2
  exit 1
fi
test -s "$work/report/report.html"
echo "smoke: ok"
