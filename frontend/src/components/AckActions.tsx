import type { MouseEvent } from 'react'
import { Button, Dialog, StateMark } from './ui'
import { acknowledgeAllCopy } from '../lib/acks'
import type { BulkAckError } from '../lib/acks'
import styles from './AckActions.module.css'

// A control inside a clickable row must not also open the row.
const stop = (event: MouseEvent) => event.stopPropagation()

export interface AckActionsProps {
  /** What the buttons act on, for the accessible names: "sahil: Session stopped answering". */
  name: string
  /** A request for this item is in flight. */
  busy?: boolean
  /** The acknowledgements were not read: the buttons are shown but cannot be used. */
  disabled?: boolean
  onAcknowledge: () => void
  /** Opens the choice of how long to shelve for. */
  onShelve: () => void
}

/**
 * The one action cell for a new, acknowledgeable item (Attention and Automations): Acknowledge, then
 * Shelve…, two small buttons of the same kind, in this order, in the row's Actions column.
 */
export function AckActions({ name, busy = false, disabled = false, onAcknowledge, onShelve }: AckActionsProps) {
  return (
    <span className={styles.actions} onClick={stop} data-ack-actions>
      <Button size="sm" loading={busy} disabled={disabled} aria-label={`Acknowledge: ${name}`} onClick={onAcknowledge}>
        Acknowledge
      </Button>
      <Button size="sm" disabled={busy || disabled} aria-label={`Shelve: ${name}`} onClick={onShelve}>
        Shelve…
      </Button>
    </span>
  )
}

/** "Acknowledge all (N)": the header button of a group of new items, and the alarm line's action. */
export function AckAllButton({ count, busy, onClick }: { count: number; busy?: boolean; onClick: () => void }) {
  return (
    <Button size="sm" loading={busy} onClick={onClick}>
      {acknowledgeAllCopy(count).button}
    </Button>
  )
}

/** The one confirmation for acknowledging several items at once, with the same words on every page. */
export function AckAllDialog({
  count,
  onCancel,
  onConfirm,
}: {
  /** Number of items it will acknowledge; zero or less keeps the dialog closed. */
  count: number
  onCancel: () => void
  onConfirm: () => void
}) {
  const copy = acknowledgeAllCopy(count)
  return (
    <Dialog
      open={count > 0}
      onClose={onCancel}
      role="alertdialog"
      title={copy.title}
      description={copy.description}
      actions={
        <>
          <Button data-autofocus onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            {copy.confirm}
          </Button>
        </>
      }
    />
  )
}

/** Where a bulk acknowledge stopped: how far it got and the server's own words. */
export function BulkAckNotice({ error }: { error: BulkAckError | null }) {
  if (!error) return null
  return (
    <p className={styles.error} role="alert">
      <StateMark state="critical" />
      <span>
        Acknowledged {error.done} of {error.total} and stopped: {error.message}
      </span>
    </p>
  )
}
