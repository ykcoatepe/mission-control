export type TaskStatus = 'queue' | 'inProgress' | 'blocked' | 'done' | 'executing'

export function normalizeTaskStatus(rawStatus: string | undefined | null, fallback: TaskStatus = 'queue'): TaskStatus {
  const status = String(rawStatus || '').trim().toLowerCase()

  if (status === 'queue') return 'queue'
  if (status === 'blocked') return 'blocked'
  if (status === 'completed' || status === 'done') return 'done'
  if (status === 'executing') return 'executing'
  if (status === 'inprogress' || status === 'in_progress' || status === 'running') return 'inProgress'
  return fallback
}

export function normalizeTaskStatusFromColumn(rawStatus: string | undefined | null, column: string = 'queue'): TaskStatus {
  const columnFallback =
    column === 'inProgress' ? 'inProgress' :
    column === 'blocked' ? 'blocked' :
    column === 'done' ? 'done' :
    'queue'

  return normalizeTaskStatus(rawStatus, columnFallback)
}

export function taskStatusLabel(rawStatus: string | undefined | null, column: string = 'queue'): string {
  const status = normalizeTaskStatusFromColumn(rawStatus, column)
  if (status === 'executing') return 'Executing'
  if (status === 'inProgress') return 'In Progress'
  if (status === 'blocked') return 'Blocked'
  if (status === 'done') return 'Done'
  return 'Queue'
}

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

export type DecisionStatus =
  | 'open'
  | 'approved'
  | 'approved_with_conditions'
  | 'rejected'
  | 'blocked'
  | 'closed'
  | 'no_consensus'
  | 'pending'
  | 'delegated'
  | 'pending_user_decision'

export type VoteStatus = 'approve' | 'conditional' | 'reject' | 'abstain'

export function normalizeVoteStatus(rawVote: string | undefined | null): VoteStatus {
  const vote = String(rawVote || '').trim().toLowerCase()
  if (vote === 'approved') return 'approve'
  if (vote === 'rejected' || vote === 'veto') return 'reject'
  if (vote === 'approved_with_conditions') return 'conditional'
  if (vote === 'approve' || vote === 'conditional' || vote === 'reject' || vote === 'abstain') return vote
  return 'abstain'
}

export function normalizeEventType(raw: string | undefined | null): string {
  const t = String(raw || '').trim()
  if (!t) return 'event'
  return t
}

export type HealthState = 'green' | 'yellow' | 'red' | 'gray'

export function normalizeHealthState(raw: string | undefined | null, fallback: HealthState = 'gray'): HealthState {
  const value = String(raw || '').trim().toLowerCase()
  if (value === 'green' || value === 'yellow' || value === 'red' || value === 'gray') return value
  return fallback
}

export function healthStateColor(state: HealthState): string {
  if (state === 'green') return '#32D74B'
  if (state === 'yellow') return '#FF9500'
  if (state === 'red') return '#FF453A'
  return '#8E8E93'
}

export function healthStateBadgeStatus(state: HealthState): 'active' | 'paused' | 'error' | 'off' {
  if (state === 'green') return 'active'
  if (state === 'yellow') return 'paused'
  if (state === 'red') return 'error'
  return 'off'
}

export function scoreToHealthState(score: number | undefined | null): HealthState {
  if (!Number.isFinite(Number(score))) return 'gray'
  const numeric = Number(score)
  if (numeric >= 85) return 'green'
  if (numeric >= 60) return 'yellow'
  if (numeric >= 1) return 'red'
  return 'gray'
}
