import type { CSSProperties } from 'react'
import { cx } from './cx'
import styles from './Skeleton.module.css'

export interface SkeletonProps {
  /** `line` = one text line, `block` = a box. */
  variant?: 'line' | 'block'
  /** Number of stacked lines (variant `line`). */
  lines?: number
  /** Block height: `md` 96px, `lg` 240px. */
  size?: 'md' | 'lg'
  /** CSS width/height overrides for data-driven sizes, e.g. `40%`. Prefer `size`. */
  width?: string
  height?: string
  /** Accessible loading message. */
  label?: string
  className?: string
}

export function Skeleton({ variant = 'line', lines = 1, size = 'md', width, height, label = 'Loading', className }: SkeletonProps) {
  const dims: CSSProperties | undefined = width || height ? { width, height } : undefined
  const count = variant === 'line' ? Math.max(1, lines) : 1
  return (
    <div className={cx(styles.stack, className)} role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cx(styles.bar, variant === 'block' && styles.block, variant === 'block' && size === 'lg' && styles.blockLg)}
          style={dims}
        />
      ))}
    </div>
  )
}
