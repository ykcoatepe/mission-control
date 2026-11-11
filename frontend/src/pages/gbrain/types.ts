export interface DiagnosticFinding {
  name: string | null
  status: string | null
  message: string | null
}

/** What a diagnostic that produced a report found (server/sources/gbrain/contract.d.ts: DiagnosticResult). */
export interface DiagnosticResult {
  reportStatus: string | null
  healthScore: number | null
  failing: DiagnosticFinding[]
  warning: DiagnosticFinding[]
  counts: {
    failing: number
    warning: number
    checks?: number
    issues?: number
    pages?: number
    missingFiles?: number
    failingOmitted?: number
    warningOmitted?: number
  }
}

export interface GBrainActionResult {
  ok: boolean
  action?: string
  label?: string
  status: string
  pending?: boolean
  summary?: string
  error?: string
  checkedAt: string
  refreshAfter?: boolean
  /** Only on a diagnostic that ran and produced a report: `clean` or `findings`. Findings are a result, not a failure. */
  outcome?: 'clean' | 'findings'
  result?: DiagnosticResult
}
