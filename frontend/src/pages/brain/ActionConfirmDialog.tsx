import { useEffect, useRef, type RefObject } from 'react'
import styles from './BrainHome.module.css'
import type { OperationCapability, OperationSystem } from './types'

export function ActionConfirmDialog({
  action,
  proof,
  onCancel,
  onConfirm,
  returnFocusRef,
}: {
  action: OperationCapability | null
  proof: OperationSystem
  onCancel: () => void
  onConfirm: () => void
  returnFocusRef: RefObject<HTMLButtonElement | null>
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const visibleAction = action?.safetyClass === 'W2' ? null : action

  useEffect(() => {
    if (!visibleAction) return
    const returnFocusTarget = returnFocusRef.current
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    confirmRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      returnFocusTarget?.focus()
    }
  }, [visibleAction, onCancel, returnFocusRef])

  if (!visibleAction) return null

  const minutes = visibleAction.timeoutMs
    ? Math.ceil(visibleAction.timeoutMs / 60_000)
    : null

  return (
    <div
      className={styles.confirmBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className={styles.confirmDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-description"
      >
        <span className={styles.confirmIdentity}>{visibleAction.safetyClass} · GBrain</span>
        <h2 id="confirm-title">{visibleAction.label}</h2>
        <p id="confirm-description">{visibleAction.description}</p>
        <dl>
          <div>
            <dt>Current proof</dt>
            <dd>{proof.state} · {proof.freshness}</dd>
          </div>
          <div>
            <dt>Expected duration</dt>
            <dd>{minutes ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : 'Not specified'}</dd>
          </div>
          <div>
            <dt>Exact action</dt>
            <dd>{visibleAction.id}</dd>
          </div>
        </dl>
        {proof.caveats[0] ? <p className={styles.confirmCaveat}>{proof.caveats[0]}</p> : null}
        <div className={styles.confirmActions}>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button ref={confirmRef} type="button" onClick={onConfirm}>
            Run {visibleAction.label}
          </button>
        </div>
      </div>
    </div>
  )
}
