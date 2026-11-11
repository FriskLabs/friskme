import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseAgentList, resolveSources } from './agents/registry.ts'
import type { AgentId } from './agents/types.ts'
import { Cache, cacheRoot } from './cache.ts'
import { FRISK_VERSION } from './constants.ts'
import { type AnalyzerId, parseAnalyzer } from './llm/runner.ts'
import { scan } from './scan.ts'
import { loadSalt } from './sensitive/mask.ts'
import { modelsCommand } from './sensitive/model/models-command.ts'
import { runNerWorker } from './sensitive/model/ner.ts'

export const HELP = `frisk ${FRISK_VERSION}: what your coding-agent sessions were actually for

Usage:
  frisk [scan] [options]     Analyze recent sessions and write a report (default)
  frisk cache clear          Delete frisk's local cache (~/.frisk/cache)
  frisk models list|download|remove
                             Manage the optional PII model (~/.frisk/models)

Options:
  --agent <list>               Agents to read: claude, codex, or both comma-separated
                               (default: every agent whose session folder exists)
  --since <30d|4w|YYYY-MM-DD>  Only sessions active since then (default 30d)
  --project <substring>        Only sessions whose working directory contains this
  --max-sessions <n>           Analyze at most the n most recent sessions
  --analyzer <claude|codex>    CLI that labels sessions: claude -p or codex exec
                               (default: claude if logged in, else codex)
  --model <name>               Model for the analyzer (default: haiku for claude,
                               Codex's own default for codex)
  --no-llm                     Skip all model calls; deterministic sections only
  --out <dir>                  Output directory (default ./frisk-report)
  --json                       Print report.json to stdout (summary goes to stderr)
  --no-sensitive               Skip the secrets and personal-data scan
  --pii-model                  Also find names and places with a local NER model
                               (downloads ~190 MB once, after asking; runs offline)
  --pii-model-scope <scope>    prompts (default): what you typed and the agent's
                               replies. all: also tool input and output (slow)
  --reveal                     Show secrets and personal data unmasked in the
                               report (files are written 0600; do not share)
  -y, --yes                    Do not ask before model calls or downloads
  -h, --help                   Show this help
  -v, --version                Show the version

Reads, read-only:
  Claude Code  ${'$'}CLAUDE_CONFIG_DIR/projects or ~/.claude/projects
  Codex        ${'$'}CODEX_HOME/sessions or ~/.codex/sessions
`

/** `30d`, `4w`, `12h` or an ISO date → epoch ms. */
export function parseSince(value: string, now: Date = new Date()): number {
  const m = /^(\d+)\s*([hdw])$/i.exec(value.trim())
  if (m) {
    const n = Number(m[1])
    const unit = m[2]!.toLowerCase()
    const ms =
      unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 7 * 86_400_000
    return now.getTime() - n * ms
  }
  const t = Date.parse(value)
  if (Number.isNaN(t))
    throw new Error(`--since: expected 30d, 4w, 12h or a date, got "${value}"`)
  return t
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        agent: { type: 'string' },
        since: { type: 'string', default: '30d' },
        project: { type: 'string' },
        'max-sessions': { type: 'string' },
        analyzer: { type: 'string' },
        model: { type: 'string' },
        'no-llm': { type: 'boolean', default: false },
        out: { type: 'string', default: './frisk-report' },
        json: { type: 'boolean', default: false },
        yes: { type: 'boolean', short: 'y', default: false },
        'no-sensitive': { type: 'boolean', default: false },
        'pii-model': { type: 'boolean', default: false },
        'pii-model-scope': { type: 'string', default: 'prompts' },
        reveal: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    })
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n\n${HELP}`,
    )
    return 2
  }
  const { values: v, positionals } = parsed
  if (v.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (v.version) {
    process.stdout.write(`${FRISK_VERSION}\n`)
    return 0
  }

  const command = positionals[0] ?? 'scan'
  // Internal: the NER worker frisk spawns for --pii-model.
  if (command === '__ner-worker') {
    await runNerWorker(String(positionals[1]))
    return 0
  }
  if (command === 'models') {
    return modelsCommand(positionals[1], { yes: Boolean(v.yes) })
  }
  if (command === 'cache') {
    if (positionals[1] !== 'clear') {
      process.stderr.write('Usage: frisk cache clear\n')
      return 2
    }
    const root = cacheRoot()
    new Cache(root).clear()
    process.stdout.write(`Deleted ${root}\n`)
    return 0
  }
  if (command !== 'scan') {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`)
    return 2
  }

  let sinceMs: number
  try {
    sinceMs = parseSince(String(v.since))
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 2
  }
  let maxSessions: number | undefined
  if (v['max-sessions'] !== undefined) {
    maxSessions = Number(v['max-sessions'])
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      process.stderr.write('--max-sessions: expected a positive integer\n')
      return 2
    }
  }

  let agents: AgentId[] | undefined
  if (v.agent !== undefined) {
    try {
      agents = parseAgentList(String(v.agent))
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`)
      return 2
    }
  }

  let analyzer: AnalyzerId | undefined
  if (v.analyzer !== undefined) {
    try {
      analyzer = parseAnalyzer(String(v.analyzer))
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`)
      return 2
    }
  }

  const scope = String(v['pii-model-scope'])
  if (scope !== 'prompts' && scope !== 'all') {
    process.stderr.write('--pii-model-scope: expected prompts or all\n')
    return 2
  }

  const result = await scan({
    sources: resolveSources(process.env, agents),
    cacheDir: cacheRoot(),
    sinceMs,
    sinceLabel: String(v.since),
    project: v.project as string | undefined,
    maxSessions,
    analyzer,
    model: v.model === undefined ? undefined : String(v.model),
    noLlm: Boolean(v['no-llm']),
    outDir: resolve(String(v.out)),
    json: Boolean(v.json),
    yes: Boolean(v.yes),
    sensitive: !v['no-sensitive'],
    piiModel: Boolean(v['pii-model']),
    piiModelScope: scope,
    reveal: Boolean(v.reveal),
    salt: loadSalt(),
  })
  return result.exitCode
}
