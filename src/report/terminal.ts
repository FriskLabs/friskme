import { join } from 'node:path'
import { truncate } from '../card/build-card.ts'
import { FRISKAI_URL } from '../constants.ts'
import { ANALYZERS } from '../llm/runner.ts'
import type { WasteKind } from '../waste/detectors.ts'
import type { Report } from './aggregate.ts'
import { formatDate, formatShare, formatTokens, formatUsd } from './format.ts'

const WASTE_KIND_LABELS: Record<WasteKind, string> = {
  loop: 'Loop that kept failing',
  'repeated-bash': 'Same command repeated',
  'error-streak': 'Error streak',
  'interrupt-ended': 'Interrupted ending',
}

const bold = (s: string, color: boolean) => (color ? `\x1b[1m${s}\x1b[22m` : s)
const dim = (s: string, color: boolean) => (color ? `\x1b[2m${s}\x1b[22m` : s)

export function renderTerminal(
  r: Report,
  opts: { outDir: string; color: boolean },
): string {
  const c = opts.color
  const o = r.overview
  const lines: string[] = []
  lines.push(
    '',
    bold(
      `frisk · ${o.sessions} sessions across ${o.projects.length} projects · ${formatDate(r.window.from)} → ${formatDate(r.window.to)}`,
      c,
    ),
  )
  if (o.agents.length > 1) {
    lines.push(
      dim(
        `  ${o.agents.map((a) => `${a.name} ${a.sessions} (${formatShare(a.share)}, ${formatUsd(a.cost)})`).join(' · ')}`,
        c,
      ),
    )
  }

  if (r.intents.length > 0) {
    lines.push('', bold('What your sessions were for', c))
    for (const it of r.intents.slice(0, 8)) {
      lines.push(
        `  ${formatShare(it.share).padStart(6)}  ${it.name}  ${dim(`${it.sessions} sessions`, c)}`,
      )
    }
    lines.push(
      dim(
        `  Share of ${o.sessions} sessions; intents named by ${r.llm.model} via ${ANALYZERS[r.llm.analyzer ?? 'claude'].callName}.`,
        c,
      ),
    )
  } else if (!r.llm.enabled) {
    lines.push('', dim('Intents skipped (--no-llm).', c))
  }

  lines.push('', bold('Repeated workflows', c))
  const wfs = r.workflows.slice(0, 3)
  if (wfs.length === 0) {
    lines.push(
      dim(
        '  None found: no intent had 4+ sessions with similar tool sequences.',
        c,
      ),
    )
  }
  wfs.forEach((w, i) => {
    lines.push(
      `  ${i + 1}. ${w.intent} ${dim(`(${w.sessions} similar sessions)`, c)}`,
    )
    lines.push(`     ${dim(truncate(w.typicalSequence, 100), c)}`)
    if (w.skillPath)
      lines.push(
        `     draft skill written to ${join(opts.outDir, w.skillPath)}`,
      )
    else if (w.note) lines.push(`     ${dim(w.note, c)}`)
  })

  lines.push('', bold('Biggest waste', c))
  const top = r.waste.top[0]
  if (!top) {
    lines.push(
      dim(
        '  No loops, repeated commands, error streaks or interrupted endings found.',
        c,
      ),
    )
  } else {
    const cost = top.cost === null ? 'unpriced model' : formatUsd(top.cost)
    lines.push(`  ${WASTE_KIND_LABELS[top.kind]}: ${top.label}`)
    lines.push(
      `  ${dim(`${top.project}, ${formatDate(top.start)} · ${formatTokens(top.tokens)} tokens · ${cost}`, c)}`,
    )
    const t = r.waste.totals
    lines.push(
      dim(
        `  All waste: ${t.items} items in ${t.sessionsAffected} of ${o.sessions} sessions, ${formatTokens(t.tokens)} tokens, ${formatUsd(t.cost)}.`,
        c,
      ),
    )
    lines.push(dim(`  Dollar figures: ${r.rates.basis}.`, c))
  }

  const sens = r.sensitive
  if (sens.enabled) {
    lines.push('', bold('Sensitive data', c))
    const t = sens.totals
    if (t.secrets + t.pii === 0) {
      lines.push(
        dim(
          `  None found in ${(sens.scannedChars / 1e6).toFixed(1)}M characters${sens.model ? '' : ' (rules only; add --pii-model for names)'}.`,
          c,
        ),
      )
    } else {
      lines.push(
        `  ${t.secretValues} secret${t.secretValues === 1 ? '' : 's'} and ${t.piiValues} personal-data value${t.piiValues === 1 ? '' : 's'} in ${t.sessions} of ${o.sessions} sessions`,
      )
      const rotate = [
        ...new Set(
          sens.findings
            .filter((f) => f.kind === 'secret' && f.confidence !== 'low')
            .map((f) => f.type),
        ),
      ]
      if (rotate.length)
        lines.push(
          `  ${c ? '\x1b[33m' : ''}Rotate: ${rotate.join(', ')}${c ? '\x1b[39m' : ''}`,
        )
      lines.push(
        sens.revealed
          ? `  ${c ? '\x1b[31m' : ''}--reveal: report.html and report.json contain these values unmasked. Do not share them.${c ? '\x1b[39m' : ''}`
          : dim(
              '  Values are masked in the report (--reveal shows them). They were sent to the model provider during the session.',
              c,
            ),
      )
    }
  }

  lines.push('', `Report: ${join(opts.outDir, 'report.html')}`)
  lines.push(
    dim(
      'This report was made on your machine. Nothing was sent to FriskAI.',
      c,
    ),
    dim(
      `For teams: see this across every developer and agent with FriskAI → ${FRISKAI_URL}`,
      c,
    ),
    '',
  )
  return lines.join('\n')
}
