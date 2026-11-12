import type { AttentionSignal } from '../../lib/signals'

// Payload types for GET /api/loops and GET /api/loops/:project.
// Shapes follow server/sources/mloop/index.js. Anything the server can fail to
// read is `| null`; the page never turns a null reading into a number.

export type Severity = 'error' | 'warning' | 'info'

export interface ApiMeta {
  ok: boolean
  stale: boolean
  observedAt: string | null
  ageMs: number | null
  error: string | { code?: string; message?: string } | null
  latencyMs?: number | null
  source?: string
}

export interface Envelope<T> {
  data: T | null
  meta: ApiMeta
}

export interface FindingCounts {
  total: number
  bySeverity: Record<Severity, number>
  byCode: Record<string, number>
}

/** `kind: 'ack'` = seen, it will stay like this; `'shelve'` = silenced, until `until` (null: until undone). */
export type AckKind = 'ack' | 'shelve'

/** An acknowledgement the server holds for an item (GET /api/attention/acks write results and every listed item). */
export interface AckRecord {
  kind: AckKind
  at: string
  until: string | null
}

/**
 * Badge-rule fields every listed item carries: `key` (stable; null for restricted rows), `ackable` (it counts
 * now, so it can be acknowledged or shelved) and `ack` (null = new, unacknowledged). All optional so an older
 * payload still reads: an item without them is not ackable.
 */
export interface AckFields {
  key?: string | null
  ackable?: boolean
  ack?: AckRecord | null
}

export interface Confirmation extends AckFields {
  id: string | null
  unit: string | null
  verification: string | null
  deadline: string | null
  overdue: boolean
  state: string
  kind: string | null
  dependsOn: string | null
}

export interface Participant {
  name: string
  role: string | null
  host: string | null
  alive: boolean
}

export interface ProjectError {
  part: string
  code: string
}

/** A project the page may show in full. */
export interface OpenProject {
  id: string
  restricted: false
  title: string | null
  outcome: string | null
  openFindings: FindingCounts
  /** null: the confirmations could not be read for this project. */
  pendingConfirmations: Confirmation[] | null
  /** null: the participants could not be read for this project. */
  participants: Participant[] | null
  lastActivityAt: string | null
  errors: ProjectError[]
}

/** A project the API only counts: no titles, no participants, no detail. */
export interface RestrictedProject {
  id: string
  restricted: true
  /** Counts only; a count the API could not read is null (typed number | null so the page checks it). */
  openFindings: number | null
  pendingConfirmations: number | null
  overdueConfirmations: number | null
  countsBasis?: string
}

export type LoopProject = OpenProject | RestrictedProject

export interface LoopFinding extends AckFields {
  code: string
  subject: string | null
  severity: Severity
  /** The full text (detail views). */
  detail: string | null
  /** The bounded first line (tables and lists). */
  summary?: string | null
  at: string | null
  count?: number
}

export interface AttentionFinding extends AckFields {
  project: string
  kind: 'finding'
  severity: Severity
  code: string
  subject: string | null
  /** The full text; tables show `summary`. */
  detail: string | null
  /** The bounded first line for tables. */
  summary?: string | null
  at: string | null
  count?: number
}

export interface AttentionRestricted {
  project: string
  kind: 'restricted'
  restricted: true
  severity: Severity
  count: number
}

export type AttentionEntry = AttentionFinding | AttentionRestricted

export interface LoopsTotals {
  projects: number
  openFindings: number
  pendingConfirmations: number
  overdueConfirmations: number
  /** The one attention number, equal to `GET /api/signals` attention; null when nothing was read. */
  needsOperator?: AttentionSignal | null
}

/** An overview system as the attention count sees it (`data.systems` of GET /api/loops, when the overview was read). */
export interface LoopSystem {
  id: string
  state: string
  held: boolean
  /** A source of this system could not be read. */
  failed: boolean
  key: string | null
  ackable: boolean
  ack: AckRecord | null
}

export interface LoopsData {
  observedAt: string | null
  totals: LoopsTotals
  projects: LoopProject[]
  attention: AttentionEntry[]
  systems?: LoopSystem[] | null
}

export interface OpenProjectDetail extends OpenProject {
  findings: LoopFinding[]
  statusMarkdown: string | null
}

export type ProjectDetail = OpenProjectDetail | RestrictedProject

// ---- derived rows (lib.ts) ----

export type AttentionFilter = 'all' | 'overdue' | 'pending' | 'findings'

/** One line of the ranked attention list. */
export type AttentionRow =
  | {
      key: string
      type: 'finding'
      project: string
      severity: Severity
      code: string
      subject: string | null
      /** The bounded first line of the finding's text. */
      summary: string | null
      at: string | null
      count: number | null
      ackKey: string | null
      ackable: boolean
      ack: AckRecord | null
    }
  | {
      key: string
      type: 'confirmation'
      project: string
      overdue: boolean
      id: string | null
      unit: string | null
      kind: string | null
      deadline: string | null
      ackKey: string | null
      ackable: boolean
      ack: AckRecord | null
    }
  | {
      key: string
      type: 'system'
      /** `system:<id>`: never a project id. */
      project: string
      systemId: string
      state: string
      failed: boolean
      held: boolean
      ackKey: string | null
      ackable: boolean
      ack: AckRecord | null
    }
  | {
      key: string
      type: 'restricted'
      project: string
      /** null: the API gave no rating for this count-only project. */
      severity: Severity | null
      /** null: the API did not give this count. */
      openFindings: number | null
      pendingConfirmations: number | null
      overdueConfirmations: number | null
    }

export interface ProjectRow {
  id: string
  restricted: boolean
  title: string | null
  /** null: not read. */
  openFindings: number | null
  /** null: not read. */
  pendingConfirmations: number | null
  /** null: not read. */
  overdueConfirmations: number | null
  /** null: not read (or restricted). */
  participants: { alive: number; total: number } | null
  lastActivityAt: string | null
}

export interface FindingGroup {
  code: string
  severity: Severity
  findings: LoopFinding[]
}
