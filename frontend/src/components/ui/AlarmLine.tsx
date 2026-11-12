import { RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNow } from '../../lib/useNow'
import { formatAsOf } from './asOf'
import { Button } from './Button'
import { cx } from './cx'
import { StateMark } from './StateMark'
import styles from './AlarmLine.module.css'

export interface AlarmAction {
  label: string
  onClick: () => void
  busy?: boolean
}

export interface AlarmLineProps {
  state: 'warning' | 'critical'
  /** The plain sentence: "Missing embeddings: 9 chunks". */
  title: ReactNode
  detail?: ReactNode
  /** At most one action, at the right end. */
  action?: AlarmAction
  /** When the abnormal state began, as a real observed time. */
  since?: string | number | Date | null
  className?: string
}

const WORD = { warning: 'Caution', critical: 'Critical' } as const

/**
 * The one alarm line of a page (HMI rule 4), at the top of the work area and only when something is abnormal:
 * the state word, a plain sentence and at most one action. Nothing abnormal means no line at all.
 * Critical is announced as an alert, caution as a status.
 */
export function AlarmLine({ state, title, detail, action, since, className }: AlarmLineProps) {
  const now = useNow()
  const sinceText = since === undefined || since === null ? null : formatAsOf(since, now)?.replace(/^as of /, 'since ') ?? null
  return (
    <div className={cx(styles.line, className)} data-state={state} role={state === 'critical' ? 'alert' : 'status'}>
      <span className={styles.state}>
        <StateMark state={state} className={styles.mark} />
        <span className={cx(styles.word, 'caps')}>{WORD[state]}</span>
      </span>
      <div className={styles.text}>
        <p className={styles.title}>{title}</p>
        {(detail || sinceText) && (
          <p className={styles.detail}>
            {detail}
            {detail && sinceText ? ' · ' : null}
            {sinceText}
          </p>
        )}
      </div>
      {action && (
        <Button
          variant="primary"
          className={styles.action}
          loading={action.busy}
          icon={action.busy ? undefined : <RefreshCw size={14} aria-hidden="true" />}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  )
}
