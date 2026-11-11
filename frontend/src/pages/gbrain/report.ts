import type { UiState } from '../../lib/state'
import type { DiagnosticFinding, DiagnosticResult, GBrainActionResult } from './types'

/** What a finished check left to read: kept on the page until it is dismissed or the next action starts. */
export interface ActionReport {
  action: string
  label: string
  summary: string
  outcome: 'clean' | 'findings'
  result: DiagnosticResult
  checkedAt: string
}

const UNHEALTHY = new Set(['unhealthy', 'fail', 'failed', 'critical', 'error', 'down'])

const list = (value: unknown): DiagnosticFinding[] => (Array.isArray(value) ? (value as DiagnosticFinding[]) : [])
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * A completed diagnostic as a report, or null when the answer is not one (a change action, an older server,
 * a result without the structured fields). Only `outcome` + `result` make a report: a failed action never does.
 */
export function readActionReport(response: GBrainActionResult | null | undefined, fallbackLabel: string): ActionReport | null {
  if (!response || response.ok !== true || response.status !== 'completed') return null
  if (response.outcome !== 'clean' && response.outcome !== 'findings') return null
  const raw = response.result
  if (!raw || typeof raw !== 'object') return null
  const failing = list(raw.failing)
  const warning = list(raw.warning)
  const counts = raw.counts && typeof raw.counts === 'object' ? raw.counts : { failing: failing.length, warning: warning.length }
  return {
    action: response.action ?? fallbackLabel,
    label: response.label || fallbackLabel,
    summary: response.summary || (response.outcome === 'clean' ? 'The check found nothing to report.' : 'The check found problems.'),
    outcome: response.outcome,
    result: {
      reportStatus: typeof raw.reportStatus === 'string' ? raw.reportStatus : null,
      healthScore: count(raw.healthScore) ?? null,
      failing,
      warning,
      counts: { ...counts, failing: count(counts.failing) ?? failing.length, warning: count(counts.warning) ?? warning.length },
    },
    checkedAt: response.checkedAt,
  }
}

/**
 * Clean is healthy. Findings are a warning, or critical when the report itself says the brain is unhealthy
 * (or any check outright failed): the state comes from the report, never from the word "findings".
 */
export function reportState(report: Pick<ActionReport, 'outcome' | 'result'>): UiState {
  if (report.outcome === 'clean') return 'healthy'
  const status = (report.result.reportStatus ?? '').trim().toLowerCase()
  return UNHEALTHY.has(status) ? 'critical' : 'warning'
}

export function reportStateLabel(report: Pick<ActionReport, 'outcome' | 'result'>): string {
  if (report.outcome === 'clean') return 'No findings'
  return reportState(report) === 'critical' ? 'Findings, unhealthy' : 'Findings'
}

function findingLine(finding: DiagnosticFinding) {
  const name = finding.name || 'Unnamed check'
  return finding.message ? `${name}: ${finding.message}` : name
}

/** Plain text for the clipboard: the title, the sentence, the score, then each check. */
export function reportCopyText(report: ActionReport): string {
  const { result } = report
  const lines = [`${report.label}: ${report.summary}`]
  if (result.healthScore !== null) lines.push(`Health score: ${result.healthScore}/100`)
  if (result.failing.length > 0) {
    lines.push('', 'Failing:', ...result.failing.map((finding) => `- ${findingLine(finding)}`))
    if (result.counts.failingOmitted) lines.push(`- ${result.counts.failingOmitted} more not listed`)
  }
  if (result.warning.length > 0) {
    lines.push('', 'Warnings:', ...result.warning.map((finding) => `- ${findingLine(finding)}`))
    if (result.counts.warningOmitted) lines.push(`- ${result.counts.warningOmitted} more not listed`)
  }
  return lines.join('\n')
}
