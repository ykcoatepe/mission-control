import styles from './BrainHome.module.css'
import type { ActionStatus } from './types'

export function BrainHomeSkeleton() {
  return (
    <div className={styles.skeleton} aria-label="Loading shared brain evidence" aria-busy="true">
      <div />
      <div />
      <div />
    </div>
  )
}

export function BrainHomeError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className={styles.errorState} role="alert">
      <span>Evidence read failed</span>
      <h1>Shared Brain unavailable</h1>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>Retry evidence read</button>
    </section>
  )
}

export function ActionStatusBanner({ status }: { status: ActionStatus }) {
  return (
    <div className={styles.actionStatus} data-state={status.state} role="status" aria-live="polite">
      <strong>{status.state}</strong>
      <span>{status.message}</span>
    </div>
  )
}
