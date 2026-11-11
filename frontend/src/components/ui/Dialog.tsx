import { useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import { useModal } from './useModal'
import styles from './Dialog.module.css'

export interface DialogProps {
  open: boolean
  onClose: () => void
  /** Accessible name and visible heading. */
  title: ReactNode
  description?: ReactNode
  /** Footer buttons. Put the primary or danger action last. */
  actions?: ReactNode
  /** Use `alertdialog` for confirmations of consequential actions. */
  role?: 'dialog' | 'alertdialog'
  size?: 'sm' | 'md'
  children?: ReactNode
}

/** Modal confirmation. Mark the safest control with `data-autofocus` to focus it on open. */
export function Dialog({ open, onClose, title, description, actions, role = 'dialog', size = 'sm', children }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()
  useModal(open, onClose, ref)
  if (!open) return null
  return createPortal(
    <div className={styles.root}>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(styles.dialog, size === 'md' && styles.md)}
      >
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {description && (
          <p id={descId} className={styles.description}>
            {description}
          </p>
        )}
        {children && <div className={styles.body}>{children}</div>}
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </div>,
    document.body,
  )
}
