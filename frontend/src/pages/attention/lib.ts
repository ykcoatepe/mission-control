// Pure derivations for the Attention page. The caller supplies `now`.
// Rule for every function here: a reading that is null stays null. It never
// becomes 0, "healthy" or "now".
import type { UiState } from '../../lib/state'
import { formatAge, parseTime } from '../../lib/time'
import type {
  ApiMeta,
  AttentionFilter,
  AttentionRow,
  Confirmation,
  FindingGroup,
  LoopFinding,
  LoopProject,
  LoopsData,
  OpenProject,
  ProjectRow,
  RestrictedProject,
  Severity,
} from './types'

const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 }

/**
 * Findings the ledger raises about a confirmation that is already a row of its
 * own (with the real deadline). Left out of the list when that project's
 * confirmations were read, so the same item is not shown twice.
 */
const CONFIRMATION_FINDING_CODES = new Set(['TEYIT_DUE', 'TEYIT_STALE', 'TEYIT_UNRESOLVED'])

function isSeverity(value: unknown): value is Severity {
  return value === 'error' || value === 'warning' || value === 'info'
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** error is critical, warning is warning, info is quiet. An unknown word is unavailable, never healthy. */
export function severityState(severity: Severity | null | undefined): UiState {
  if (severity === 'error') return 'critical'
  if (severity === 'warning') return 'warning'
  if (severity === 'info') return 'inactive'
  return 'unavailable'
}

export function severityLabel(severity: Severity | null | undefined): string {
  if (severity === 'error') return 'Error'
  if (severity === 'warning') return 'Warning'
  if (severity === 'info') return 'Info'
  return 'Not rated'
}

export function isRestricted(project: LoopProject): project is RestrictedProject {
  return project.restricted === true
}

// ---- words ----

/**
 * Plain words for the ledger's finding codes. Built from the codes the API
 * actually returns (GET /api/loops, byCode and attention[].code). A code that is
 * not listed here keeps its raw text: the page never invents a meaning.
 */
const FINDING_LABELS: Record<string, string> = {
  ACK_MISSING: 'Result not acknowledged',
  ACCEPTED_NOT_LIVE: 'Accepted, not live yet',
  AUTHORITY_UNQUOTED: 'Approval has no quoted reason',
  BINDING_DEAD: 'Session stopped answering',
  CODEX_GOAL_NOT_ACTIVE: 'Codex goal is not active',
  DEPLOYED_UNCONFIRMED: 'Deployed, not confirmed yet',
  ESCALATED_ROUNDS: 'Escalated after repeated rounds',
  GROKBOT_WEBHOOK_UNAVAILABLE: 'Grok bot wake-up is off',
  GUEST_PUSH_UNSEEN: 'Message sent, not seen',
  GUEST_SENDER_UNVERIFIED: 'Sender not verified',
  IMPLEMENTER_SILENT: 'Implementer is silent',
  MANAGER_SILENT: 'Manager is silent',
  PAUSED_STALE: 'Paused for too long',
  QUEUED_NOT_DELIVERED: 'Queued message not delivered',
  ROUND_CAP_REACHED: 'Round limit reached',
  STATUS_PAGE_STALE: 'Status page is out of date',
  TEYIT_DUE: 'Confirmation due soon',
  TEYIT_KEEP_KILL: 'Keep-or-stop decision pending',
  TEYIT_RESCHEDULED_REPEATEDLY: 'Confirmation pushed back repeatedly',
  TEYIT_STALE: 'Confirmation overdue',
  TEYIT_UNRESOLVED: 'Confirmation unresolved',
}

/** The plain-words label of a finding code, or null when the code is not one the page knows. */
export function findingLabelOrNull(code: string | null | undefined): string | null {
  if (!code) return null
  return Object.prototype.hasOwnProperty.call(FINDING_LABELS, code) ? FINDING_LABELS[code] : null
}

/** The plain-words label of a finding code; an unknown code falls back to the raw code. */
export function findingLabel(code: string): string {
  return findingLabelOrNull(code) ?? code
}

/** `/Users/<name>/…` and `/home/<name>/…` become `~/…`. Other text is returned unchanged. */
export function shortenHomePaths(text: string): string
export function shortenHomePaths(text: string | null | undefined): string | null
export function shortenHomePaths(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  return text.replace(/(?:\/Users|\/home)\/[^/\s]+(\/)?/g, (_match, slash?: string) => (slash ? '~/' : '~'))
}

/** A session id (`01a1a0b8-ee6e-7473-b1ac-a0e46370ff66`) is long and says nothing at a glance: its first block is enough. */
const SESSION_ID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g

/** "2026-11-03T09:25:15+00:00" becomes "3 Nov, 09:25" (local time). Text that is not a time is untouched. */
export function plainTimes(text: string): string {
  return text.replace(ISO_TIME, (match) => {
    const ms = Date.parse(match)
    if (!Number.isFinite(ms)) return match
    return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  })
}

/** A command the ledger suggests (`mloop --project x unbind ...`) starts at `mloop` followed by an option or a subcommand. */
const COMMAND_START = /\bmloop\s+(?:--|(?:check|bind|unbind|send|inbox|decide|deploy|confirm|ready|dispatch|init)\b)/

export interface TextParts {
  /** The sentence an operator reads: no command, times in plain words, home paths shortened. */
  summary: string
  /** The command to run, shown in a code block; null when the text holds none. */
  command: string | null
  /** The command was cut short by the server (it ends with an ellipsis): do not present it as runnable. */
  commandCut: boolean
}

/**
 * Splits ledger text into a plain one-line summary and the raw command it carries.
 * "<what happened>; <who> self: mloop --project … unbind … && mloop … bind …" becomes
 * summary "<what happened>" and the command as its own block. Text without a command is
 * returned whole (times and home paths made plain).
 */
export function splitCommand(text: string | null | undefined): TextParts {
  const raw = typeof text === 'string' ? text : ''
  const start = COMMAND_START.exec(raw)
  const plain = (value: string) => plainTimes(shortenHomePaths(value)).replace(/\s+/g, ' ').trim()
  if (!start) return { summary: plain(raw), command: null, commandCut: false }
  let head = raw.slice(0, start.index).trimEnd()
  // The clause that introduces the command ("managers self:") is not part of what happened.
  if (head.endsWith(':')) {
    const cut = head.lastIndexOf(';')
    head = cut >= 0 ? head.slice(0, cut) : head.slice(0, -1)
  }
  const command = raw.slice(start.index).trim()
  return {
    summary: plain(head.replace(/[\s;:,]+$/, '')),
    command: shortenHomePaths(command),
    commandCut: command.endsWith('…') || command.endsWith('...'),
  }
}

/** For one table line: also shortens session ids. The full text stays in the tooltip and the drawer. */
export function tableSummary(text: string | null | undefined): TextParts {
  const parts = splitCommand(text)
  return { ...parts, summary: parts.summary.replace(SESSION_ID, '$1…') }
}

// ---- time ----

export interface Timing {
  kind: 'overdue' | 'upcoming' | 'none'
  text: string
}

/**
 * "due in 5h", "3d overdue" or "—". A missing or unreadable deadline is "—":
 * it is never "now" and never overdue on its own.
 */
export function deadlineTiming(deadline: string | null | undefined, overdueFlag: boolean, now: number): Timing {
  const ms = parseTime(deadline)
  if (ms === null) return overdueFlag ? { kind: 'overdue', text: 'overdue' } : { kind: 'none', text: '—' }
  if (overdueFlag || ms <= now) {
    return ms < now ? { kind: 'overdue', text: `${formatAge(ms, now)} overdue` } : { kind: 'overdue', text: 'overdue' }
  }
  return { kind: 'upcoming', text: `due in ${formatAge(now, ms)}` }
}

/** Age of a finding: "3d", or "—" when its time is missing. */
export function findingAge(at: string | null | undefined, now: number): string {
  const ms = parseTime(at)
  return ms === null ? '—' : formatAge(ms, now)
}

// ---- confirmations ----

/** Earliest deadline first; a missing deadline sorts last. */
export function compareDeadline(a: string | null | undefined, b: string | null | undefined): number {
  const left = parseTime(a)
  const right = parseTime(b)
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left - right
}

export function sortConfirmations(items: Confirmation[]): Confirmation[] {
  return [...items].sort((a, b) => compareDeadline(a.deadline, b.deadline))
}

export function isOverdue(item: Pick<Confirmation, 'overdue' | 'deadline'>, now: number): boolean {
  if (item.overdue === true) return true
  const ms = parseTime(item.deadline)
  return ms !== null && ms < now
}

/** "live_confirmation" becomes "live confirmation"; a missing kind is "—". */
export function confirmationKindLabel(kind: string | null | undefined): string {
  if (!kind) return '—'
  return kind.replace(/[_-]+/g, ' ').trim() || '—'
}

// ---- attention rows ----

function rowTier(row: AttentionRow): number {
  if (row.type === 'confirmation') return row.overdue ? 1 : 3
  if (row.severity === 'error') return 0
  if (row.severity === 'warning') return 2
  if (row.severity === 'info') return 4
  return 5
}

function rowTime(row: AttentionRow): string | null {
  if (row.type === 'finding') return row.at
  if (row.type === 'confirmation') return row.deadline
  return null
}

export function compareRows(a: AttentionRow, b: AttentionRow): number {
  const tier = rowTier(a) - rowTier(b)
  if (tier !== 0) return tier
  const time = compareDeadline(rowTime(a), rowTime(b))
  if (time !== 0) return time
  return a.project.localeCompare(b.project) || a.key.localeCompare(b.key)
}

/**
 * The ranked list: findings from the API's attention list, pending
 * confirmations from each project, and one count-only row per restricted
 * project. Errors and overdue confirmations first; inside a group, the
 * longest-waiting (oldest finding, earliest deadline) first.
 */
export function buildAttentionRows(data: LoopsData, now: number): AttentionRow[] {
  const rows: AttentionRow[] = []
  const restrictedSeverity = new Map<string, Severity>()
  const confirmationsRead = new Set(
    data.projects.filter((p) => !isRestricted(p) && Array.isArray(p.pendingConfirmations)).map((p) => p.id),
  )

  data.attention.forEach((entry, index) => {
    if (entry.kind === 'finding') {
      if (CONFIRMATION_FINDING_CODES.has(entry.code) && confirmationsRead.has(entry.project)) return
      rows.push({
        key: `${entry.project}:finding:${entry.code}:${entry.subject ?? ''}:${index}`,
        type: 'finding',
        project: entry.project,
        severity: isSeverity(entry.severity) ? entry.severity : 'warning',
        code: entry.code,
        subject: entry.subject,
        summary: typeof entry.summary === 'string' ? entry.summary : null,
        at: entry.at,
        count: finiteNumber(entry.count),
      })
    } else if (entry.kind === 'restricted' && isSeverity(entry.severity)) {
      restrictedSeverity.set(entry.project, entry.severity)
    }
  })

  for (const project of data.projects) {
    if (isRestricted(project)) {
      // A count the API did not give stays null. Only a project whose counts are all read and all zero is left out.
      const openFindings = finiteNumber(project.openFindings)
      const pending = finiteNumber(project.pendingConfirmations)
      const overdue = finiteNumber(project.overdueConfirmations)
      if (openFindings === 0 && pending === 0 && overdue === 0) continue
      rows.push({
        key: `${project.id}:restricted`,
        type: 'restricted',
        project: project.id,
        severity: restrictedSeverity.get(project.id) ?? null,
        openFindings,
        pendingConfirmations: pending,
        overdueConfirmations: overdue,
      })
      continue
    }
    for (const [index, item] of (project.pendingConfirmations ?? []).entries()) {
      rows.push({
        key: `${project.id}:confirmation:${item.id ?? index}`,
        type: 'confirmation',
        project: project.id,
        overdue: isOverdue(item, now),
        id: item.id,
        unit: item.unit,
        kind: item.kind,
        deadline: item.deadline,
      })
    }
  }
  return rows.sort(compareRows)
}

export const ATTENTION_FILTERS: readonly AttentionFilter[] = ['all', 'overdue', 'pending', 'findings']

/** The filter named in the URL; anything else is "all". */
export function parseAttentionFilter(value: string | null | undefined): AttentionFilter {
  return ATTENTION_FILTERS.find((filter) => filter === value) ?? 'all'
}

export interface FilterChipOption {
  value: AttentionFilter
  label: string
  /** The number of confirmations or findings this chip covers; absent when a count in scope was not read. */
  count?: number
}

/** Sum of one count over the projects in scope; null as soon as one of them was not read (never a partial total). */
function scopedTotal(rows: ProjectRow[], pick: (row: ProjectRow) => number | null): number | null {
  let total = 0
  for (const row of rows) {
    const value = pick(row)
    if (value === null) return null
    total += value
  }
  return total
}

/**
 * The filter chips. A chip counts the same unit as the stat beside it: Overdue and Pending count
 * confirmations, Findings counts findings, both taken from every project in scope (a restricted
 * project contributes its counts). "All" carries no count: its unit is list rows, which the
 * "Showing x of y" line already states. A chip that would leave the list unchanged is not offered
 * (the one currently chosen stays so it can be switched off).
 */
export function filterChipOptions(
  allRows: AttentionRow[],
  projectRows: ProjectRow[],
  project: string,
  active: AttentionFilter,
): FilterChipOption[] {
  const scoped = project === 'all' ? projectRows : projectRows.filter((row) => row.id === project)
  const listed = filterRows(allRows, 'all', project).length
  const chip = (value: AttentionFilter, label: string, count: number | null): FilterChipOption =>
    count === null ? { value, label } : { value, label, count }
  const candidates: FilterChipOption[] = [
    chip('overdue', 'Overdue confirmations', scopedTotal(scoped, (row) => row.overdueConfirmations)),
    chip('pending', 'Pending confirmations', scopedTotal(scoped, (row) => row.pendingConfirmations)),
    chip('findings', 'Findings', scopedTotal(scoped, (row) => row.openFindings)),
  ]
  return [
    { value: 'all', label: 'All' },
    ...candidates.filter(
      (candidate) =>
        candidate.value === active || filterRows(allRows, candidate.value, project).length !== listed,
    ),
  ]
}

export function filterRows(rows: AttentionRow[], filter: AttentionFilter, project: string): AttentionRow[] {
  return rows.filter((row) => {
    if (project !== 'all' && row.project !== project) return false
    if (filter === 'all') return true
    if (row.type === 'restricted') {
      // An unread count never matches a filter.
      if (filter === 'overdue') return (row.overdueConfirmations ?? 0) > 0
      if (filter === 'pending') return (row.pendingConfirmations ?? 0) > 0
      return (row.openFindings ?? 0) > 0
    }
    if (filter === 'findings') return row.type === 'finding'
    if (filter === 'pending') return row.type === 'confirmation'
    return row.type === 'confirmation' && row.overdue
  })
}

// ---- projects ----

function participantCount(project: OpenProject): ProjectRow['participants'] {
  if (!Array.isArray(project.participants)) return null
  return { alive: project.participants.filter((p) => p.alive === true).length, total: project.participants.length }
}

export function buildProjectRows(projects: LoopProject[], now: number): ProjectRow[] {
  const rows = projects.map<ProjectRow>((project) => {
    if (isRestricted(project)) {
      return {
        id: project.id,
        restricted: true,
        title: null,
        openFindings: finiteNumber(project.openFindings),
        pendingConfirmations: finiteNumber(project.pendingConfirmations),
        overdueConfirmations: finiteNumber(project.overdueConfirmations),
        participants: null,
        lastActivityAt: null,
      }
    }
    const pending = Array.isArray(project.pendingConfirmations) ? project.pendingConfirmations : null
    return {
      id: project.id,
      restricted: false,
      title: project.title,
      openFindings: finiteNumber(project.openFindings?.total),
      pendingConfirmations: pending ? pending.length : null,
      overdueConfirmations: pending ? pending.filter((item) => isOverdue(item, now)).length : null,
      participants: participantCount(project),
      lastActivityAt: project.lastActivityAt,
    }
  })
  return rows.sort(
    (a, b) =>
      (b.overdueConfirmations ?? -1) - (a.overdueConfirmations ?? -1) ||
      (b.openFindings ?? -1) - (a.openFindings ?? -1) ||
      (b.pendingConfirmations ?? -1) - (a.pendingConfirmations ?? -1) ||
      a.id.localeCompare(b.id),
  )
}

export interface Summary {
  projects: number | null
  projectsWithOpenItems: number
  openFindings: number | null
  pendingConfirmations: number | null
  overdueConfirmations: number | null
  /** Projects whose confirmations could not be read; the totals leave them out. */
  unreadProjects: number
}

export function summarize(data: LoopsData): Summary {
  let withOpen = 0
  let unread = 0
  for (const project of data.projects) {
    if (isRestricted(project)) {
      const findings = finiteNumber(project.openFindings)
      const pending = finiteNumber(project.pendingConfirmations)
      if (findings === null || pending === null) unread++
      if ((findings ?? 0) + (pending ?? 0) > 0) withOpen++
      continue
    }
    if (!Array.isArray(project.pendingConfirmations)) unread++
    if ((finiteNumber(project.openFindings?.total) ?? 0) + (project.pendingConfirmations?.length ?? 0) > 0) withOpen++
  }
  return {
    projects: finiteNumber(data.totals?.projects) ?? data.projects.length,
    projectsWithOpenItems: withOpen,
    openFindings: finiteNumber(data.totals?.openFindings),
    pendingConfirmations: finiteNumber(data.totals?.pendingConfirmations),
    overdueConfirmations: finiteNumber(data.totals?.overdueConfirmations),
    unreadProjects: unread,
  }
}

// ---- detail ----

/** Findings grouped by code: worst severity first, then the larger group, then code. */
export function groupFindingsByCode(findings: LoopFinding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>()
  for (const finding of findings) {
    const severity = isSeverity(finding.severity) ? finding.severity : 'warning'
    const group = groups.get(finding.code)
    if (group) {
      group.findings.push({ ...finding, severity })
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[group.severity]) group.severity = severity
    } else {
      groups.set(finding.code, { code: finding.code, severity, findings: [{ ...finding, severity }] })
    }
  }
  const list = [...groups.values()]
  for (const group of list) group.findings.sort((a, b) => compareDeadline(a.at, b.at))
  return list.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.findings.length - a.findings.length ||
      a.code.localeCompare(b.code),
  )
}

// ---- envelope ----

export function errorText(error: ApiMeta['error'] | undefined): string | null {
  if (!error) return null
  if (typeof error === 'string') return error
  return error.message || error.code || null
}
