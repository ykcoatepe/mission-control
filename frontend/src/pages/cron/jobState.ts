import { normalizeCronStatus } from '../../lib/status'
import type { UiState } from '../../lib/state'
import type { CronJob } from './types'

export interface JobState {
  state: UiState
  label: string
}

/**
 * Operator-facing state of a job. Only a run result makes a job "active" or
 * "failed"; a job that is on but has reported nothing is "waiting", never green.
 */
export function jobState(job: Pick<CronJob, 'status' | 'enabled'>): JobState {
  const status = normalizeCronStatus(job.status, job.enabled)
  if (status === 'disabled') return { state: 'inactive', label: 'Paused' }
  if (status === 'failed') return { state: 'critical', label: 'Failed' }
  if (status === 'active') return { state: 'healthy', label: 'Active' }
  return { state: 'unavailable', label: 'Waiting' }
}
