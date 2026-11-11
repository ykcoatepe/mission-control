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
        detail: entry.detail,
        at: entry.at,
        count: finiteNumber(entry.count),
      })
    } else if (entry.kind === 'restricted' && isSeverity(entry.severity)) {
      restrictedSeverity.set(entry.project, entry.severity)
    }
  })

  for (const project of data.projects) {
    if (isRestricted(project)) {
      const openFindings = finiteNumber(project.openFindings) ?? 0
      const pending = finiteNumber(project.pendingConfirmations) ?? 0
      const overdue = finiteNumber(project.overdueConfirmations) ?? 0
      if (openFindings + pending + overdue === 0) continue
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

export function filterRows(rows: AttentionRow[], filter: AttentionFilter, project: string): AttentionRow[] {
  return rows.filter((row) => {
    if (project !== 'all' && row.project !== project) return false
    if (filter === 'all') return true
    if (row.type === 'restricted') {
      if (filter === 'overdue') return row.overdueConfirmations > 0
      if (filter === 'pending') return row.pendingConfirmations > 0
      return row.openFindings > 0
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
        openFindings: finiteNumber(project.openFindings) ?? 0,
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
      openFindings: finiteNumber(project.openFindings?.total) ?? 0,
      pendingConfirmations: pending ? pending.length : null,
      overdueConfirmations: pending ? pending.filter((item) => isOverdue(item, now)).length : null,
      participants: participantCount(project),
      lastActivityAt: project.lastActivityAt,
    }
  })
  return rows.sort(
    (a, b) =>
      (b.overdueConfirmations ?? -1) - (a.overdueConfirmations ?? -1) ||
      b.openFindings - a.openFindings ||
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
      if ((finiteNumber(project.openFindings) ?? 0) + (finiteNumber(project.pendingConfirmations) ?? 0) > 0) withOpen++
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
