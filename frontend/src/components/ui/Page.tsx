import type { ReactNode } from 'react'
import { cx } from './cx'
import { usePublishPageTitle } from './pageTitleContext'
import styles from './Page.module.css'

export interface PageProps {
  /** Shown once, in the top bar, and used for `document.title`. */
  title: string
  /** One line under the top bar: the question this page answers. */
  description?: ReactNode
  /** Page-level actions, right-aligned on the description row. */
  actions?: ReactNode
  /** A `<Tabs>` (or similar) row between the header row and the content. */
  tabs?: ReactNode
  /** `default` = 1480px frame, `narrow` = 960px, `full` = no max width. */
  width?: 'default' | 'narrow' | 'full'
  className?: string
  children: ReactNode
}

export function Page({ title, description, actions, tabs, width = 'default', className, children }: PageProps) {
  usePublishPageTitle(title)
  const hasHeader = Boolean(description) || Boolean(actions)
  return (
    <div className={cx(styles.page, width === 'narrow' && styles.narrow, width === 'full' && styles.full, className)}>
      {hasHeader && (
        <div className={styles.header}>
          {description ? <p className={styles.description}>{description}</p> : <span />}
          {actions && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      {tabs && <div className={styles.tabs}>{tabs}</div>}
      <div className={styles.content}>{children}</div>
    </div>
  )
}
