import type { ComponentProps, ReactNode } from 'react'
import { cx } from './cx'
import { labelText } from './labelText'
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
  'aria-label': ariaLabel,
  ...rest
}: ButtonProps) {
  // An accessible name that is written, not inferred from content: it survives a label that is clipped or hidden at some width.
  const name = ariaLabel ?? (rest['aria-labelledby'] ? undefined : labelText(children).trim() || undefined)
  return (
    <button
      {...rest}
      aria-label={name}
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
