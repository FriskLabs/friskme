import { createHash } from 'node:crypto'
import type { TextVisit } from '../parse/common.ts'
import { detectInText } from './detect.ts'
import { fingerprint, maskValue } from './mask.ts'
import type {
  Detection,
  SegmentSource,
  SensitiveFinding,
  TextSegment,
} from './types.ts'

/** Sources the optional NER model reads by default: what people wrote. */
export const PROMPT_SCOPE: SegmentSource[] = [
  'typed-prompt',
  'slash-command',
  'assistant-text',
]

export type ModelScope = 'prompts' | 'all'

export function inModelScope(
  source: SegmentSource,
  scope: ModelScope,
): boolean {
  return scope === 'all' || PROMPT_SCOPE.includes(source)
}

type Pending = Omit<SensitiveFinding, 'project'>

/**
 * Accumulates findings while transcripts stream past. Raw values exist only
 * inside `add` long enough to be masked and fingerprinted. Segments for the
 * optional model are kept (in memory, for this run only) when requested.
 */
export class SensitiveCollector {
  private readonly bySession = new Map<string, Map<string, Pending>>()
  readonly modelSegments: TextSegment[] = []
  chars = 0
  segments = 0
  /** Detections by a hash of the text, so repeats are not rescanned and text is not retained. In memory only. */
  private readonly seenText = new Map<string, Detection[]>()

  constructor(
    private readonly salt: Buffer,
    private readonly opts: {
      rules: boolean
      modelScope: ModelScope | null
      /** Keep raw values for the report (--reveal). Off by default. */
      reveal?: boolean
    },
  ) {}

  /** A visitor bound to one session, for the parser. */
  visitor(sessionId: string): (seg: TextVisit) => void {
    return (seg) => {
      this.segments++
      this.chars += seg.text.length
      if (this.opts.rules) {
        // The same file read twice is detected once; each occurrence still counts.
        const h = createHash('sha1').update(seg.text).digest('base64')
        let found = this.seenText.get(h)
        if (!found) {
          found = detectInText(seg.text)
          this.seenText.set(h, found)
        }
        for (const d of found) this.add(sessionId, seg, d)
      }
      if (
        this.opts.modelScope &&
        inModelScope(seg.source, this.opts.modelScope)
      ) {
        this.modelSegments.push({ sessionId, ...seg })
      }
    }
  }

  add(sessionId: string, seg: Omit<TextVisit, 'text'>, d: Detection): void {
    this.addMasked(sessionId, seg, {
      kind: d.kind,
      type: d.type,
      confidence: d.confidence,
      detector: d.detector,
      masked: maskValue(d),
      fingerprint: fingerprint(d.value, this.salt),
      value: d.value,
    })
  }

  /** For model output and cache hits, which never carry the raw value. */
  addMasked(
    sessionId: string,
    seg: Omit<TextVisit, 'text'>,
    d: Pick<
      SensitiveFinding,
      'kind' | 'type' | 'confidence' | 'detector' | 'masked' | 'fingerprint'
    > & { value?: string },
  ): void {
    const fp = d.fingerprint
    const key = `${d.type}:${fp}`
    const session = this.bySession.get(sessionId) ?? new Map<string, Pending>()
    this.bySession.set(sessionId, session)
    const prev = session.get(key)
    if (prev) {
      prev.occurrences++
      return
    }
    session.set(key, {
      kind: d.kind,
      type: d.type,
      confidence: d.confidence,
      detector: d.detector,
      masked: d.masked,
      fingerprint: fp,
      sessionId,
      source: seg.source,
      tool: seg.tool,
      ts: seg.ts,
      occurrences: 1,
      // Raw values are kept only when the user asked to see them.
      ...(this.opts.reveal && d.value !== undefined ? { value: d.value } : {}),
    })
  }

  /** Findings for the sessions the scan kept; others (outside the window, frisk's own) are dropped. */
  findings(projectOf: Map<string, string>): SensitiveFinding[] {
    const out: SensitiveFinding[] = []
    for (const [sessionId, m] of this.bySession) {
      const project = projectOf.get(sessionId)
      if (project === undefined) continue
      for (const f of m.values()) out.push({ ...f, project })
    }
    return out
  }

  /** Drop the text kept for the model once it has run. */
  releaseText(): void {
    this.modelSegments.length = 0
    this.seenText.clear()
  }
}
