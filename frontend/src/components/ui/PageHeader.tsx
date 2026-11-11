import type { ReactNode } from 'react'
import { usePublishPageTitle } from './pageTitleContext'
import styles from './PageHeader.module.css'

interface PageHeaderProps {
  /** @deprecated Icons are not shown in the flat design; accepted for compatibility. */
  icon?: ReactNode
  title: string
  subtitle: string
}

/**
 * Legacy adapter. The title is published to the top bar (shown once) and only the
 * subtitle renders in the page. New pages use `Page`.
 */
export default function PageHeader({ title, subtitle }: PageHeaderProps) {
  usePublishPageTitle(title)
  return subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null
}
