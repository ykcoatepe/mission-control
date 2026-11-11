import { Button, Dialog, Mono, StatePill, TimeAgo } from '../../components/ui'
import type { UiState } from '../../lib/state'
import { confirmLabel, plainWords } from './lib'
import styles from './ActionConfirmDialog.module.css'
import type { OperationCapability } from './types'

export interface ConfirmContext {
  /** The state shown for GBrain right now. */
  state: UiState
  /** When the reading behind that state was taken; null when it was never read. */
  observedAt: string | null
  /** The reading is older than it should be. */
  stale: boolean
  /** First current note, if any. */
  note: string | null
}

export function ActionConfirmDialog({
  action,
  context,
  onCancel,
  onConfirm,
}: {
  action: OperationCapability | null
  context: ConfirmContext
  onCancel: () => void
  onConfirm: () => void
}) {
  // A class-W2 action never gets a dialog: it can not be confirmed here.
  const visible = action && action.safetyClass !== 'W2' ? action : null
  const minutes = visible?.timeoutMs ? Math.ceil(visible.timeoutMs / 60_000) : null

  return (
    <Dialog
      open={visible !== null}
      onClose={onCancel}
      role="alertdialog"
      title={visible ? `${visible.label}?` : ''}
      description={visible ? plainWords(visible.description) : undefined}
      actions={
        <>
          <Button data-autofocus onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            {visible ? confirmLabel(visible) : 'Run'}
          </Button>
        </>
      }
    >
      {visible && (
        <>
          <dl className={styles.facts}>
            <div>
              <dt>GBrain state</dt>
              <dd>
                <StatePill state={context.state} />
              </dd>
            </div>
            <div>
              <dt>Last read</dt>
              <dd>
                <TimeAgo value={context.observedAt} fallback="not read" />
                {context.stale && <span className={styles.stale}> · stale</span>}
              </dd>
            </div>
            <div>
              <dt>Expected duration</dt>
              <dd>{minutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : 'Not specified'}</dd>
            </div>
          </dl>
          {context.note && <p className={styles.note}>{context.note}</p>}
          <p className={styles.actionId}>
            Action <Mono muted>{visible.id}</Mono>
          </p>
        </>
      )}
    </Dialog>
  )
}
