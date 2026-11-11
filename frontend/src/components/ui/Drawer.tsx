import { X } from 'lucide-react'
import { useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import { IconButton } from './IconButton'
import { useModal } from './useModal'
import styles from './Drawer.module.css'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  /** Accessible name and visible heading. */
  title: ReactNode
  description?: ReactNode
  /** Sticky footer, e.g. action buttons. */
  footer?: ReactNode
  size?: 'md' | 'lg'
  children: ReactNode
}

/** Right-side detail panel: the home of evidence and detail. */
export function Drawer({ open, onClose, title, description, footer, size = 'md', children }: DrawerProps) {
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
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(styles.drawer, size === 'lg' && styles.lg)}
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {description && (
              <p id={descId} className={styles.description}>
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close" icon={<X size={16} />} onClick={onClose} />
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
