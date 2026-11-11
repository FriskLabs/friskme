export type SensitiveKind = 'secret' | 'pii'

/**
 * high: a provider-specific secret, or validated PII with a context word.
 * medium: validated PII without context.
 * low: a generic entropy match; counted and kept in report.json only.
 */
export type Confidence = 'high' | 'medium' | 'low'

/** Where in a session the text came from. */
export type SegmentSource =
  | 'typed-prompt'
  | 'slash-command'
  | 'tool-input'
  | 'tool-output'
  | 'assistant-text'
  | 'compact-summary'
  | 'subagent'

export type TextSegment = {
  sessionId: string
  source: SegmentSource
  /** Tool step key (`Read:env`, `Bash:file_ops`) for tool input and output. */
  tool: string | null
  ts: string
  text: string
}

/** One match inside one text. `value` is raw and must never leave memory. */
export type Detection = {
  kind: SensitiveKind
  type: string
  confidence: Confidence
  detector: string
  value: string
}

/** What the report stores: masked and fingerprinted, never raw. */
export type SensitiveFinding = {
  kind: SensitiveKind
  type: string
  confidence: Confidence
  detector: string
  masked: string
  fingerprint: string
  sessionId: string
  project: string
  source: SegmentSource
  tool: string | null
  ts: string
  /** Times this value appeared in this session. */
  occurrences: number
  /** The raw value. Present only with --reveal. */
  value?: string
}
