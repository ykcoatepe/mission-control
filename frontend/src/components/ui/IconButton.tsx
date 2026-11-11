import type { ComponentProps, ReactNode } from 'react'
import { cx } from './cx'
import styles from './IconButton.module.css'

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children' | 'aria-label'> {
  /** Required accessible name; also the native tooltip. */
  label: string
  icon: ReactNode
  variant?: 'ghost' | 'secondary'
  size?: 'sm' | 'md'
  /** For toggle buttons: sets `aria-pressed`. */
  pressed?: boolean
  /** Small state-coloured count/dot overlaid on the corner, e.g. unread. */
  badge?: ReactNode
}

export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  pressed,
  badge,
  type = 'button',
  className,
  title,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      className={cx(styles.button, variant === 'secondary' && styles.secondary, size === 'sm' && styles.sm, className)}
    >
      {icon}
      {badge !== undefined && badge !== null && <span className={styles.badge}>{badge}</span>}
    </button>
  )
}
