import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Block.module.css'

export type BlockTone = 'reference' | 'projects' | 'agent' | 'curated'

export interface BlockProps {
  /** Shown in condensed capitals. */
  title?: ReactNode
  /** The count or total, at the right of the header: "20,788 pages", "Showing 6 of 6". */
  meta?: ReactNode
  /** Controls after the meta, e.g. a `Button size="sm"`. */
  actions?: ReactNode
  /** The GBrain source group this block belongs to; fills the header with its line colour. Nothing else uses it. */
  tone?: BlockTone
  /** One quiet line under the header. */
  description?: ReactNode
  /** `none` for tables and lists that run edge to edge. */
  padding?: 'md' | 'sm' | 'none'
  /** Heading element for the title. Default `h2`. */
  titleAs?: 'h2' | 'h3'
  id?: string
  className?: string
  'aria-label'?: string
  children?: ReactNode
}

/**
 * The one container (HMI rule 6): a 1px outline, a small radius and a header in condensed capitals with the
 * count at the right. No shadow, no gradient, never nested inside another block.
 */
export function Block({
  title,
  meta,
  actions,
  tone,
  description,
  padding = 'md',
  titleAs: Heading = 'h2',
  id,
  className,
  'aria-label': ariaLabel,
  children,
}: BlockProps) {
  const hasHeader = Boolean(title) || Boolean(meta) || Boolean(actions)
  const hasBody = children !== undefined && children !== null && children !== false
  return (
    <section
      id={id}
      aria-label={ariaLabel}
      data-tone={tone}
      className={cx(styles.block, padding === 'sm' && styles.padSm, padding === 'none' && styles.padNone, className)}
    >
      {hasHeader && (
        <header className={styles.header}>
          {title && <Heading className={cx(styles.title, 'caps')}>{title}</Heading>}
          {(meta || actions) && (
            <div className={styles.end}>
              {meta && <span className={styles.meta}>{meta}</span>}
              {actions && <div className={styles.actions}>{actions}</div>}
            </div>
          )}
        </header>
      )}
      {description && <p className={styles.description}>{description}</p>}
      {hasBody && <div className={styles.body}>{children}</div>}
    </section>
  )
}
