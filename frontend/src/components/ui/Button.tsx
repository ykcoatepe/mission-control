import type { ComponentProps, ReactNode } from 'react'
import { cx } from './cx'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  /** `primary` (cyan) is for the single main action of a view. */
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  /** Disables the button and shows a spinner. The label stays for layout and screen readers. */
  loading?: boolean
  /** Icon before the label. */
  icon?: ReactNode
  children?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  type = 'button',
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(styles.button, styles[variant], size === 'sm' && styles.sm, className)}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon}
      {children !== undefined && children !== null && <span className={styles.label}>{children}</span>}
    </button>
  )
}
