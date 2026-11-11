import { Button, Dialog, Mono, StatePill } from '../../components/ui'
import type { UiState } from '../../lib/state'
import { plainWords } from './lib'
import styles from './ActionConfirmDialog.module.css'
import type { OperationCapability } from './types'

export interface ConfirmContext {
  /** The state shown for GBrain right now. */
  state: UiState
  /** "fresh", "stale" or "not read". */
  freshness: string
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
            {visible ? `Run ${visible.label}` : 'Run'}
          </Button>
        </>
      }
    >
      {visible && (
        <>
          <dl className={styles.facts}>
            <div>
              <dt>Current reading</dt>
              <dd>
                <StatePill state={context.state} /> <span className={styles.muted}>{context.freshness}</span>
              </dd>
            </div>
            <div>
              <dt>Expected duration</dt>
              <dd>{minutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : 'Not specified'}</dd>
            </div>
            <div>
              <dt>Exact action</dt>
              <dd>
                <Mono>{visible.id}</Mono>
              </dd>
            </div>
          </dl>
          {context.note && <p className={styles.note}>{context.note}</p>}
        </>
      )}
    </Dialog>
  )
}
