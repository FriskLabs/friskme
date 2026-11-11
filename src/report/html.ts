import { agentName } from '../agents/registry.ts'
import { FRISKAI_URL } from '../constants.ts'
import { ANALYZERS } from '../llm/runner.ts'
import type { SensitiveValue } from '../sensitive/summary.ts'
import type { SegmentSource } from '../sensitive/types.ts'
import type { WasteKind } from '../waste/detectors.ts'
import type {
  Count,
  IntentReport,
  Report,
  WorkflowReport,
} from './aggregate.ts'
import { formatDate, formatShare, formatTokens, formatUsd } from './format.ts'
import { renderSkill } from './skill-files.ts'

const SOURCE_LABELS: Record<SegmentSource, string> = {
  'typed-prompt': 'you typed',
  'slash-command': 'slash command',
  'tool-input': 'tool input',
  'tool-output': 'tool output',
  'assistant-text': 'agent reply',
  'compact-summary': 'compaction summary',
  subagent: 'subagent',
}

const MAX_SENSITIVE_ROWS = 100

function sensitiveSection(r: Report): string {
  const s = r.sensitive
  if (!s.enabled) return '<p class="dim">Skipped (--no-sensitive).</p>'
  const t = s.totals
  const detectors = `rules (${s.rulesVersion})${s.model ? ` and the ${s.model.name} model run locally on ${s.model.scope === 'all' ? 'all text' : "what you typed and the agent's replies"} (${(s.model.chars / 1e6).toFixed(1)}M chars, ${s.model.seconds}s, ${s.model.cachedChunks} of ${s.model.chunks} chunks from cache)` : ''}`
  const basisLine = comment(
    `Scanned ${(s.scannedChars / 1e6).toFixed(1)}M characters in ${s.segments.toLocaleString('en-US')} text blocks: prompts, tool input and output, agent replies and subagents. Detectors: ${detectors}. ${s.revealed ? 'Values are shown unmasked (--reveal).' : 'Values are masked; run with --reveal to see them.'} ${t.lowConfidence} low-confidence matches are listed in report.json only.${s.model ? '' : ' Names and places need --pii-model.'}`,
  )
  if (s.summary.length === 0) return `<p>Nothing found.</p>${basisLine}`
  const shown = s.findings.filter((f) => f.confidence !== 'low')
  const secretTypes = [
    ...new Set(shown.filter((f) => f.kind === 'secret').map((f) => f.type)),
  ]
  const action = secretTypes.length
    ? `<p class="warn">Rotate: ${esc(secretTypes.join(', '))}. These values appeared in a session, so they were sent to the model provider with the rest of the conversation.</p>`
    : ''
  const summary = table(
    [
      ['kind', 'l'],
      ['type', 'l'],
      ['confidence', 'l'],
      ['values', 'r'],
      ['seen', 'r'],
      ['sessions', 'r'],
      ['where', 'l'],
    ],
    s.summary.map((row) => [
      row.kind === 'secret' ? '<span class="warn">secret</span>' : 'personal',
      esc(row.type),
      `<span class="${row.confidence === 'low' ? 'dim' : ''}">${row.confidence}</span>`,
      String(row.uniqueValues),
      String(row.occurrences),
      String(row.sessions),
      `<span class="dim">${esc(
        row.sources
          .slice(0, 3)
          .map((x) => `${SOURCE_LABELS[x.source]} ${x.count}`)
          .join(', '),
      )}</span>`,
    ]),
  )
  const values = s.values.filter((v) => v.confidence !== 'low')
  const more =
    values.length > MAX_SENSITIVE_ROWS
      ? comment(
          `${values.length - MAX_SENSITIVE_ROWS} more values in report.json.`,
        )
      : ''
  // The per-value list is long; it starts collapsed behind one toggle.
  return `${action}${summary}${basisLine}
<details class="all-values">
  <summary>show all ${values.length} values</summary>
<div class="vcols" aria-hidden="true"><span>type</span><span>value</span><span class="num">seen</span><span class="num">sessions</span><span>where</span><span>first → last</span></div>
${values.slice(0, MAX_SENSITIVE_ROWS).map(valueRow).join('')}${more}
</details>`
}

function where(sources: SensitiveValue['sources'], limit = 3): string {
  return sources
    .slice(0, limit)
    .map(
      (x) =>
        `${SOURCE_LABELS[x.source]}${x.tool ? ` ${x.tool}` : ''} ${x.count}`,
    )
    .join(', ')
}

/** One line per distinct value; expanding it lists every session it appeared in. */
function valueRow(v: SensitiveValue): string {
  const first = formatDate(v.firstSeen)
  const last = formatDate(v.lastSeen)
  // Same year: `2026-11-05 → 11-11` keeps the column narrow.
  const span =
    first === last
      ? first
      : first.slice(0, 4) === last.slice(0, 4)
        ? `${first} → ${last.slice(5)}`
        : `${first} → ${last}`
  const seenIn = table(
    [
      ['session', 'l'],
      ['project', 'l'],
      ['date', 'l'],
      ['where', 'l'],
      ['times', 'r'],
    ],
    v.seenIn.map((x) => [
      `<code class="nowrap" title="claude --resume ${esc(x.sessionId)}">${esc(x.sessionId.slice(0, 8))}</code>`,
      `<span class="nowrap">${esc(x.project)}</span>`,
      `<span class="nowrap">${esc(formatDate(x.ts))}</span>`,
      `<span class="nowrap">${esc(SOURCE_LABELS[x.source])}${x.tool ? ` <span class="dim">${esc(x.tool)}</span>` : ''}</span>`,
      String(x.occurrences),
    ]),
  )
  return `
<details class="value">
  <summary>
    <span class="${v.kind === 'secret' ? 'warn' : ''}">${esc(v.type)}</span>
    <code${v.value !== undefined ? ` class="revealed" title="${esc(v.masked)}"` : ''}>${esc(v.value ?? v.masked)}</code>
    <span class="num">${v.occurrences}</span>
    <span class="num">${v.sessions}</span>
    <span class="dim">${esc(where(v.sources))}</span>
    <span class="dim nowrap">${esc(span)}</span>
  </summary>
  <div class="body">
    ${seenIn}
    ${comment(`${v.confidence} confidence, detected by ${v.detectors.join(', ')}. Projects: ${v.projects.join(', ')}. Hover a session id for its claude --resume command.`)}
  </div>
</details>`
}

/** Everything that came from a transcript or a model is escaped. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const WASTE_LABELS: Record<WasteKind, string> = {
  loop: 'failing loops',
  'repeated-bash': 'repeated commands',
  'error-streak': 'error streaks',
  'interrupt-ended': 'interrupted endings',
}

/** One flagged item, in a table row. */
const WASTE_ITEM_LABELS: Record<WasteKind, string> = {
  loop: 'failing loop',
  'repeated-bash': 'repeated command',
  'error-streak': 'error streak',
  'interrupt-ended': 'interrupted end',
}

const SPARK = '▁▂▃▄▅▆▇█'

/** Weekly counts as block characters, like a terminal sparkline. */
export function sparkline(weekly: IntentReport['weekly']): string {
  const max = Math.max(1, ...weekly.map((w) => w.count))
  const title = weekly.map((w) => `${w.weekStart}: ${w.count}`).join('\n')
  const chars = weekly
    .map((w) =>
      w.count === 0
        ? '<i>▁</i>'
        : SPARK[Math.min(7, Math.max(1, Math.round((w.count / max) * 7)))],
    )
    .join('')
  return `<span class="spark" title="${esc(title)}" aria-label="Sessions per week: ${weekly.map((w) => w.count).join(', ')}">${chars}</span>`
}

/** A share of all sessions, drawn on a track that is the whole. */
function bar(share: number): string {
  const pct = Math.max(share > 0 ? 0.6 : 0, Math.min(100, share * 100))
  return `<span class="bar" aria-hidden="true"><span style="width:${pct.toFixed(2)}%"></span></span>`
}

function comment(text: string): string {
  return `<p class="comment">// ${esc(text)}</p>`
}

function counts(items: Count[]): string {
  if (items.length === 0) return '<span class="dim">none</span>'
  return items
    .map((i) => `<span class="ct">${esc(i.name)}<sup>${i.count}</sup></span>`)
    .join(' ')
}

function kv(rows: [string, string][]): string {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
}

function intentRow(it: IntentReport, r: Report): string {
  return `
<details class="intent">
  <summary>
    <span class="num">${formatShare(it.share)}</span>
    ${bar(it.share)}
    <span class="name">${esc(it.name)}</span>
    <span class="num">${it.sessions}</span>
    ${sparkline(it.weekly)}
  </summary>
  <div class="body">
    <p>${esc(it.description)}</p>
    ${kv([
      ...(r.overview.agents.length > 1
        ? ([['agents', counts(it.agents)]] as [string, string][])
        : []),
      ['tools', counts(it.topTools)],
      ['projects', counts(it.projects)],
      ['labels', counts(it.labels)],
      [
        'weekly',
        esc(
          it.weekly.map((w) => `${w.weekStart.slice(5)}=${w.count}`).join('  '),
        ),
      ],
    ])}
    <blockquote>${it.examples.map((e) => `<p>${esc(e)}</p>`).join('')}</blockquote>
    ${comment(`${it.sessions} of ${r.overview.sessions} sessions. ${formatTokens(it.tokens)} tokens, ${formatUsd(it.cost)} at ${r.rates.basis}.`)}
  </div>
</details>`
}

function workflowBlock(w: WorkflowReport, r: Report): string {
  const skill = w.skill
  const preview =
    skill && w.skillPath
      ? `<p class="path"><span class="dim">wrote</span> ${esc(w.skillPath)}</p>
  <details class="file"><summary>show SKILL.md</summary><pre>${esc(
    renderSkill(skill, {
      intent: w.intent,
      sessions: w.sessions,
      date: formatDate(r.generatedAt),
    }),
  )}</pre></details>`
      : `<p class="dim">${esc(w.note ?? 'No draft written.')}</p>`
  return `
<section class="workflow">
  <h3>${esc(w.intent)}</h3>
  ${comment(`${w.sessions} sessions${w.structural ? ', structural match' : ''} with a tool mix at cosine ≥ 0.8 to the most typical one (mean ${w.meanSimilarity.toFixed(2)}).`)}
  <pre class="seq">${esc(w.typicalSequence)}</pre>
  ${preview}
</section>`
}

function table(headers: [string, 'l' | 'r'][], rows: string[][]): string {
  return `<div class="scroll"><table><thead><tr>${headers
    .map(([h, a]) => `<th class="${a}">${esc(h)}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((c, i) => `<td class="${headers[i]?.[1] ?? 'l'}">${c}</td>`).join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`
}

export function renderHtml(r: Report): string {
  const o = r.overview
  const period = `${formatDate(r.window.from)} → ${formatDate(r.window.to)}`
  const command = `frisk scan --since ${r.window.since}${r.llm.enabled ? '' : ' --no-llm'}`
  const skipped = r.source
  const ignored = Object.entries(skipped.ignoredLineTypes).sort(
    (a, b) => b[1] - a[1],
  )
  const unknown = Object.entries(skipped.unknownLineTypes)
  const redactions = Object.entries(r.llm.redactions)
  const wasteKinds = Object.keys(WASTE_LABELS) as WasteKind[]

  const multiAgent = o.agents.length > 1
  const wasteRows = r.waste.top
    .slice(0, 25)
    .map((w) => [
      `<span class="warn nowrap">${esc(WASTE_ITEM_LABELS[w.kind])}</span>`,
      `<code>${esc(w.label.replace(/`/g, ''))}</code>${w.editRunError ? ' <span class="warn">edit → run → error</span>' : ''}`,
      `<span class="nowrap">${esc(w.project)}${multiAgent ? ` <span class="dim">${esc(agentName(w.agent))}</span>` : ''}</span>`,
      `<span class="nowrap">${esc(formatDate(w.start))}</span>`,
      esc(formatTokens(w.tokens)),
      w.cost === null
        ? '<span class="dim">unpriced</span>'
        : esc(formatUsd(w.cost)),
    ])

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(agentsTitle(r))} Report</title>
<style>
:root{
  --paper:#fdfdfc;--ink:#1f2328;--dim:#6e7781;--rule:#d8dee4;--wash:#f3f5f7;
  --blue:#0550ae;--track:#e6edf5;--warn:#953800;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,"JetBrains Mono",Menlo,Consolas,"Liberation Mono",monospace;
  color-scheme:light
}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.6 var(--mono);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
main{max-width:100ch;margin:0 auto;padding:40px 16px 80px}
a{color:var(--blue);text-decoration-thickness:1px;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
p{margin:0 0 8px}
code{font:inherit}
.dim,.dim a{color:var(--dim)}
.warn{color:var(--warn)}
.revealed{overflow-wrap:anywhere}
.banner{border:1px solid var(--warn);color:var(--warn);padding:8px 12px;margin:0 0 20px}
.cmd{color:var(--dim);margin-bottom:20px}
.cmd b{color:var(--ink);font-weight:500}
h1{font-size:22px;line-height:1.3;font-weight:700;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:15px;font-weight:700;margin:48px 0 12px;padding-top:16px;border-top:1px solid var(--rule)}
h2::before{content:"## ";color:var(--dim);font-weight:400}
h3{font-size:14px;font-weight:700;margin:0 0 2px}
h3::before{content:"### ";color:var(--dim);font-weight:400}
.comment{color:var(--dim);margin:2px 0 12px}
nav{display:flex;flex-wrap:wrap;gap:4px 18px;margin:16px 0 0}
nav a{color:var(--dim);text-decoration:none}
nav a:hover{color:var(--blue)}
nav a::before{content:"#"}
.kv{display:grid;grid-template-columns:14ch 1fr;gap:2px 16px;margin:0 0 12px}
.kv dt{color:var(--dim)}
.kv dd{margin:0;overflow-wrap:anywhere}
.big{font-weight:700}
.ct{white-space:nowrap;margin-right:10px}
.ct sup{color:var(--dim);font-size:11px;margin-left:2px;vertical-align:4px}
.bar{display:block;height:10px;background:var(--track);align-self:center}
.bar span{display:block;height:100%;background:var(--blue)}
.spark{color:var(--blue);letter-spacing:1px;white-space:nowrap}
.spark i{color:var(--rule);font-style:normal}
.cols,.intent>summary{display:grid;grid-template-columns:8ch minmax(80px,22ch) 1fr 5ch 9ch;gap:14px;align-items:baseline;padding:5px 8px}
.cols{color:var(--dim);border-bottom:1px solid var(--rule)}
.num{text-align:right}
.intent{border-bottom:1px solid var(--wash)}
.intent>summary{cursor:pointer;list-style:none}
.intent>summary::-webkit-details-marker{display:none}
.intent>summary:hover{background:var(--wash)}
.intent>summary .name::before{content:"▸ ";color:var(--dim)}
.intent[open]>summary .name::before{content:"▾ "}
.intent[open]>summary{background:var(--wash)}
.vcols,.value>summary{display:grid;grid-template-columns:20ch 16ch 5ch 8ch minmax(0,1fr) 18ch;gap:12px;align-items:baseline;padding:5px 8px}
.value>summary>span,.value>summary>code{min-width:0;overflow-wrap:anywhere}
.vcols{color:var(--dim);border-bottom:1px solid var(--rule);margin-top:16px}
.value{border-bottom:1px solid var(--wash)}
.value>summary{cursor:pointer;list-style:none}
.value>summary::-webkit-details-marker{display:none}
.value>summary:hover,.value[open]>summary{background:var(--wash)}
.value>summary>span:first-child::before{content:"▸ ";color:var(--dim)}
.value[open]>summary>span:first-child::before{content:"▾ "}
.value .body{padding:8px 8px 12px 12px;border-left:2px solid var(--blue);margin-left:8px}
.intent .body{padding:12px 8px 16px calc(8ch + 22px);border-left:2px solid var(--blue);margin-left:8px}
blockquote{margin:8px 0 12px;padding:0}
blockquote p{margin:0 0 6px;padding-left:2ch;text-indent:-2ch}
blockquote p::before{content:"> ";color:var(--dim)}
.workflow{margin:0 0 28px}
pre{margin:8px 0;font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
.seq{background:var(--wash);padding:10px 12px;border-left:2px solid var(--rule);font-size:13px}
.path{margin:8px 0 4px}
.file>summary{cursor:pointer;color:var(--blue);width:max-content}
.all-values>summary{cursor:pointer;color:var(--blue);width:max-content;margin:8px 0}
.all-values[open]>summary{margin-bottom:0}
.file pre{border:1px solid var(--rule);padding:12px 14px;font-size:13px;max-height:420px;overflow:auto;background:#fff}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:5px 8px;border-bottom:1px solid var(--wash);vertical-align:top}
th{color:var(--dim);font-weight:400;border-bottom:1px solid var(--rule);white-space:nowrap}
.nowrap{white-space:nowrap}
.l{text-align:left}.r{text-align:right;white-space:nowrap}
.method{list-style:none;padding:0;margin:0}
.method li{padding-left:2ch;text-indent:-2ch;margin:0 0 8px}
.method li::before{content:"- ";color:var(--dim)}
.method b{font-weight:700}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--rule);color:var(--dim)}
@media (max-width:640px){
  body{font-size:13px}
  .cols{display:none}
  .intent>summary{grid-template-columns:7ch 1fr 4ch;gap:4px 10px}
  .intent>summary .bar{grid-column:1/-1;grid-row:2}
  .intent>summary .spark{display:none}
  .intent .body{padding-left:12px}
  .vcols{display:none}
  .value>summary{grid-template-columns:1fr auto;gap:2px 10px}
  .value>summary>span:nth-child(n+3){grid-column:1/-1}
  .kv{grid-template-columns:1fr}
  .kv dd{margin-bottom:6px}
}
@media print{.intent .body{display:block}}
</style>
</head>
<body>
<main>
<header>
  <p class="cmd">$ <b>${esc(command)}</b></p>
  ${r.sensitive.revealed ? '<p class="banner" role="alert">This report contains unmasked secrets and personal data (--reveal). Keep it on this machine; do not share or commit it.</p>' : ''}
  <h1>What your ${esc(agentsTitle(r))} sessions were for</h1>
  ${comment(`${o.sessions} sessions in ${o.projects.length} projects, ${period}. Generated on this machine by frisk ${r.friskVersion}.`)}
  <nav aria-label="Sections"><a href="#overview">overview</a><a href="#intents">intents</a><a href="#workflows">workflows</a><a href="#waste">waste</a><a href="#sensitive">sensitive</a><a href="#method">method</a></nav>
</header>

<h2 id="overview">Overview</h2>
${kv([
  [
    'sessions',
    `<span class="big">${o.sessions}</span> <span class="dim">with a prompt you typed</span>`,
  ],
  ...(multiAgent
    ? ([
        [
          'agents',
          o.agents
            .map(
              (a) =>
                `<span class="ct">${esc(a.name)}<sup>${a.sessions} · ${formatShare(a.share)} · ${esc(formatUsd(a.cost))}</sup></span>`,
            )
            .join(' '),
        ],
      ] as [string, string][])
    : []),
  ['prompts', `${o.prompts}`],
  [
    'tool calls',
    `${o.toolCalls.toLocaleString('en-US')} <span class="dim">(${o.toolErrors} failed)</span>`,
  ],
  [
    'tokens',
    `${formatTokens(o.tokens)} <span class="dim">incl. cache and subagents</span>`,
  ],
  [
    'list price',
    `<span class="big">${formatUsd(o.cost)}</span> <span class="dim">API equivalent</span>`,
  ],
  ['projects', counts(o.projects.slice(0, 12))],
  [
    'models',
    o.models
      .map(
        (m) =>
          `<span class="ct">${esc(m.model)}<sup>${formatTokens(m.tokens)}</sup></span>`,
      )
      .join(' '),
  ],
  ...(o.categories.length
    ? ([
        [
          'work type',
          o.categories
            .map(
              (c) =>
                `<span class="ct">${esc(c.name)}<sup>${formatShare(c.count / Math.max(1, o.sessions))}</sup></span>`,
            )
            .join(' '),
        ],
      ] as [string, string][])
    : []),
])}
${comment(`Tokens count each API response once, including subagent runs. Dollars are ${r.rates.basis}; on a subscription you do not pay this.${o.unpricedModels.length ? ` No rate for ${o.unpricedModels.join(', ')}; excluded from dollar totals.` : ''}`)}

<h2 id="intents">Intents</h2>
${
  r.intents.length
    ? `${comment(`Labeled by ${r.llm.model} from each session's prompts and tool sequence, then merged into intents. Counts and shares computed locally. Bars are share of all ${o.sessions} sessions. ${r.llm.unlabeledSessions} sessions unlabeled.`)}
<div class="cols" aria-hidden="true"><span class="num">share</span><span>of all</span><span>intent</span><span class="num">n</span><span>weekly</span></div>
${r.intents.map((it) => intentRow(it, r)).join('')}`
    : `<p class="dim">${r.llm.enabled ? 'No intents: labeling produced no results.' : 'Skipped. Run without --no-llm to name intents with claude -p or codex exec.'}</p>`
}

<h2 id="workflows">Repeated workflows</h2>
${
  r.workflows.length
    ? `${comment('Draft skills are written to disk, never installed. Read one before copying it to ~/.claude/skills/.')}${r.workflows.map((w) => workflowBlock(w, r)).join('')}`
    : '<p class="dim">None found. A workflow needs 4 or more sessions in one intent that used tools in similar proportions.</p>'
}

<h2 id="waste">Waste</h2>
${table(
  [
    ['kind', 'l'],
    ['items', 'r'],
    ['tokens', 'r'],
    ['list price', 'r'],
  ],
  [
    ...wasteKinds.map((k) => [
      esc(WASTE_LABELS[k]),
      String(r.waste.byKind[k].items),
      esc(formatTokens(r.waste.byKind[k].tokens)),
      esc(formatUsd(r.waste.byKind[k].cost)),
    ]),
    [
      '<b>total</b>',
      `<b>${r.waste.totals.items}</b>`,
      `<b>${esc(formatTokens(r.waste.totals.tokens))}</b>`,
      `<b>${esc(formatUsd(r.waste.totals.cost))}</b>`,
    ],
  ],
)}
${comment(`${r.waste.totals.sessionsAffected} of ${o.sessions} sessions affected. A failing loop is a tool pattern repeated 3+ times where at least 2 iterations, and at least half, failed. Repeated commands are the same shell command 3+ times (sleep polling excluded). An error streak is 3+ failed calls in a row. Priced from the responses after the first attempt; each response counted once in totals. Deterministic, no model involved.`)}
${
  wasteRows.length
    ? table(
        [
          ['kind', 'l'],
          ['what', 'l'],
          ['project', 'l'],
          ['date', 'l'],
          ['tokens', 'r'],
          ['cost', 'r'],
        ],
        wasteRows,
      )
    : '<p class="dim">Nothing flagged.</p>'
}

<h2 id="sensitive">Sensitive data</h2>
${sensitiveSection(r)}

<h2 id="method">Method and caveats</h2>
<ul class="method">
<li><b>read</b> ${skipped.files} session files and ${skipped.subagentFiles} subagent files under ${skipped.roots.map((x) => `<code>${esc(x.path)}</code> (${esc(agentName(x.agent))}${skipped.byAgent[x.agent] ? `, ${skipped.byAgent[x.agent]!.files} files` : ''})`).join(', ') || 'no agent folders'}, read-only. Nothing there was changed.</li>
<li><b>kept</b> ${o.sessions} sessions active since ${esc(r.window.since)}. Skipped ${skipped.skippedOutsideWindow} outside the window, ${skipped.skippedNoPrompt} with no typed prompt, ${skipped.skippedFriskSelf} created by frisk${skipped.filteredByProject ? `, ${skipped.filteredByProject} outside --project` : ''}.</li>
<li><b>lines</b> ${skipped.malformedLines} malformed lines skipped. Ignored by design: ${ignored.map(([k, v]) => `${esc(k)} (${v})`).join(', ') || 'none'}.${unknown.length ? ` Unknown line types, ignored: ${unknown.map(([k, v]) => `${esc(k)} (${v})`).join(', ')}.` : ''}</li>
<li><b>sent</b> ${
    r.llm.enabled
      ? `${r.llm.calls} <code>${esc(analyzerInfo(r).callName)}</code> ${r.llm.calls === 1 ? 'call' : 'calls'} to ${esc(r.llm.model)} under your own ${esc(analyzerInfo(r).loginName)} login, ${r.llm.failedCalls} failed. Labeling sent each session's first prompt (≤600 chars), up to 5 follow-ups (≤200 chars each), the project folder name and folded tool names. Grouping sent only labels and counts. Skill drafting sent 3–5 of the same cards. Secrets were redacted first${redactions.length ? ` (${redactions.map(([k, v]) => `${esc(k)}: ${v}`).join(', ')})` : ', none found'}. ${r.llm.analyzer === 'codex' ? 'Calls ran ephemeral, without your Codex config, MCP servers, AGENTS.md, web search or the shell tool, in a read-only sandbox and an empty folder.' : 'Calls ran with no tools, no session persistence and safe mode.'} ${r.llm.labelsFromCache} labels came from the local cache. ${r.llm.costUsd === null ? `${esc(analyzerInfo(r).callName)} does not report cost, so frisk's own calls are not priced.` : `frisk's own calls cost ${formatUsd(r.llm.costUsd)} at list price.`}`
      : 'nothing (--no-llm).'
  }</li>
${r.llm.groupingFellBack ? '<li><b>fallback</b> grouping failed twice, so intents are work categories.</li>' : ''}
${r.llm.labelsLeftUngrouped ? `<li><b>ungrouped</b> ${r.llm.labelsLeftUngrouped} labels the grouping step left out were put in "Other work".</li>` : ''}
${r.llm.skillDraftsFailed ? `<li><b>skills</b> ${r.llm.skillDraftsFailed} drafts failed and were not written.</li>` : ''}
<li><b>rates</b> ${esc(r.rates.basis)}, bundled with frisk. No pricing was fetched.</li>
${r.sensitive.model ? `<li><b>pii model</b> ${esc(r.sensitive.model.name)} at revision ${esc(r.sensitive.model.revision.slice(0, 12))}, downloaded once from huggingface.co (model) and registry.npmjs.org (ONNX Runtime), every file checked against a SHA-256 pinned in frisk. It ran on this machine; no text was sent anywhere.</li>` : ''}
<li><b>history</b> Claude Code deletes transcripts older than <code>cleanupPeriodDays</code> (30 by default), so this covers about a month at most.</li>
</ul>

<footer>// This report was made on your machine. Nothing was sent to FriskAI.<br>// For teams: the same view across every developer and agent, in <a href="${esc(FRISKAI_URL)}">FriskAI</a>.</footer>
</main>
</body>
</html>
`
}

function analyzerInfo(r: Report) {
  return ANALYZERS[r.llm.analyzer ?? 'claude']
}

/** `Claude Code`, `Codex`, or `Claude Code and Codex`: whichever agents the report covers. */
function agentsTitle(r: Report): string {
  const names = r.overview.agents.map((a) => a.name)
  if (names.length === 0) return 'coding-agent'
  return names.join(' and ')
}
