import { useState } from 'react'
import type { MouseEvent } from 'react'
import { Button, StateMark } from '../../components/ui'
import { SHELVE_OPTIONS } from '../../lib/acks'
import type { AckActions } from '../../lib/acks'
import styles from './AckControls.module.css'

interface AckControlsProps {
  /** The item's ack key. */
  ackKey: string
  /** What the controls act on, for the accessible names: "sahil: Session stopped answering". */
  name: string
  actions: AckActions
  /** `new`: Acknowledge and Shelve…; `standing`: Undo. */
  mode: 'new' | 'standing'
}

/** The server's message for a failed request, next to the control that sent it. */
export function AckError({ message }: { message: string | undefined }) {
  if (!message) return null
  return (
    <p className={styles.error} role="alert">
      <StateMark state="critical" />
      <span>{message}</span>
    </p>
  )
}

// A control inside a clickable row must not also open the row.
const stop = (event: MouseEvent) => event.stopPropagation()

export default function AckControls({ ackKey, name, actions, mode }: AckControlsProps) {
  const [shelving, setShelving] = useState(false)
  const busy = actions.busy.has(ackKey)
  const error = actions.errors[ackKey]

  return (
    <div className={styles.controls} onClick={stop}>
      {mode === 'standing' ? (
        <div className={styles.buttons}>
          <Button size="sm" loading={busy} aria-label={`Undo: ${name}`} onClick={() => void actions.undo(ackKey)}>
            Undo
          </Button>
        </div>
      ) : shelving ? (
        <div className={styles.buttons} role="group" aria-label={`Shelve ${name} for`}>
          <span className={styles.shelveLabel}>Shelve for</span>
          {SHELVE_OPTIONS.map((option) => (
            <Button
              key={option.value}
              size="sm"
              disabled={busy}
              onClick={() => void actions.shelve(ackKey, option.value)}
              aria-label={`Shelve ${name}: ${option.label}`}
            >
              {option.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setShelving(false)}
            aria-label={`Cancel shelving ${name}`}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className={styles.buttons}>
          <Button
            size="sm"
            loading={busy}
            aria-label={`Acknowledge: ${name}`}
            onClick={() => void actions.acknowledge(ackKey)}
          >
            Acknowledge
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Shelve: ${name}`}
            onClick={() => setShelving(true)}
          >
            Shelve…
          </Button>
        </div>
      )}
      <AckError message={error} />
    </div>
  )
}
