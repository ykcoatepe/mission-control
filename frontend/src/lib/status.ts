export type CronStatus = 'active' | 'idle' | 'disabled' | 'failed'

export function normalizeCronStatus(rawStatus: string | undefined | null, enabled = true): CronStatus {
  if (!enabled) return 'disabled'

  const status = String(rawStatus || '').trim().toLowerCase()
  if (status === 'disabled') return 'disabled'
  if (status === 'active' || status === 'running' || status === 'ok' || status === 'success') return 'active'
  if (status === 'failed' || status === 'error' || status === 'errored') return 'failed'
  return 'idle'
}

export function normalizeDecisionStatus(rawStatus: string | undefined | null): string {
  const status = String(rawStatus || '').trim().toLowerCase()
  if (!status) return 'open'
  if (status === 'active') return 'open'
  if (status === 'approved with conditions') return 'approved_with_conditions'
  return status
}

export function isOpenDecisionStatus(rawStatus: string | undefined | null): boolean {
  const status = normalizeDecisionStatus(rawStatus)
  return ['open', 'pending', 'pending_user_decision', 'delegated'].includes(status)
}

export type HealthState = 'green' | 'yellow' | 'red' | 'gray'

export function normalizeHealthState(raw: string | undefined | null, fallback: HealthState = 'gray'): HealthState {
  const value = String(raw || '').trim().toLowerCase()
  if (value === 'green' || value === 'yellow' || value === 'red' || value === 'gray') return value
  return fallback
}
