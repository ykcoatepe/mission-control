import { Notice } from '../../components/ui'
import type { UiState } from '../../lib/state'
import type { ActionStatus } from './types'

const TONE: Record<ActionStatus['state'], UiState | 'info'> = {
  running: 'info',
  verifying: 'warning',
  verified: 'info',
  'pending-reading': 'warning',
  failed: 'critical',
  complete: 'info',
}

const TITLE: Record<ActionStatus['state'], string> = {
  running: 'Running',
  verifying: 'Verifying',
  verified: 'Verified',
  'pending-reading': 'Waiting for a reading',
  failed: 'Failed',
  complete: 'Done',
}

/** What the last action did. "Verifying" stays amber until a newer, fresh reading arrives. */
export function ActionStatusNotice({ status }: { status: ActionStatus }) {
  return (
    <Notice tone={TONE[status.state]} title={TITLE[status.state]}>
      {status.message}
    </Notice>
  )
}
