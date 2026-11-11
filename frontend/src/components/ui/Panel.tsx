import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Panel.module.css'

export interface PanelProps {
  title?: ReactNode
  description?: ReactNode
  /** Right-aligned header controls. */
  actions?: ReactNode
  /** `none` for tables and lists that run edge to edge. */
  padding?: 'md' | 'sm' | 'none'
  /** Heading element for the title. Default `h2`. */
  titleAs?: 'h2' | 'h3'
  id?: string
  className?: string
  'aria-label'?: string
  children?: ReactNode
}

export function Panel({
  title,
  description,
  actions,
  padding = 'md',
  titleAs: Heading = 'h2',
  id,
  className,
  'aria-label': ariaLabel,
  children,
}: PanelProps) {
  const hasHeader = Boolean(title) || Boolean(actions)
  return (
    <section
      id={id}
      aria-label={ariaLabel}
      className={cx(styles.panel, padding === 'sm' && styles.padSm, padding === 'none' && styles.padNone, className)}
    >
      {hasHeader && (
        <header className={styles.header}>
          <div className={styles.heading}>
            {title && <Heading className={styles.title}>{title}</Heading>}
            {description && <p className={styles.description}>{description}</p>}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      {children !== undefined && children !== null && <div className={styles.body}>{children}</div>}
    </section>
  )
}
