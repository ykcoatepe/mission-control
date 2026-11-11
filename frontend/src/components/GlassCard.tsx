import type { ReactNode } from 'react'
import { cx } from './ui/cx'
import styles from './GlassCard.module.css'

interface Props {
  children: ReactNode
  className?: string
  /** @deprecated No hover movement in the flat design; accepted for compatibility. */
  hover?: boolean
  /** @deprecated No entrance animation; accepted for compatibility. */
  delay?: number
  noPad?: boolean
  overflowVisible?: boolean
}

/**
 * Legacy adapter: a flat bordered surface. New code uses `Panel` from `components/ui`.
 */
export default function GlassCard({ children, className = '', noPad = false, overflowVisible = false }: Props) {
  return (
    <div className={cx(styles.card, overflowVisible && styles.visible, className)}>
      <div className={noPad ? undefined : styles.pad}>{children}</div>
    </div>
  )
}
