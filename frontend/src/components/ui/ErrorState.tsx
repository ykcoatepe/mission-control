import { RotateCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from './Button'
import { cx } from './cx'
import { StateMark } from './StateMark'
import styles from './ErrorState.module.css'

export interface ErrorStateProps {
  /** What could not be read, in plain words: "Automations could not be read". */
  title?: string
  /** The reason, if known. */
  message?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  /** Extra action next to Retry. */
  action?: ReactNode
  className?: string
}

export function ErrorState({
  title = 'This could not be read',
  message,
  onRetry,
  retryLabel = 'Retry',
  action,
  className,
}: ErrorStateProps) {
  return (
    <div className={cx(styles.wrap, className)} role="alert">
      <StateMark state="critical" className={styles.mark} />
      <p className={styles.title}>{title}</p>
      {message && <p className={styles.message}>{message}</p>}
      {(onRetry || action) && (
        <div className={styles.actions}>
          {onRetry && (
            <Button icon={<RotateCw size={14} aria-hidden="true" />} onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  )
}
