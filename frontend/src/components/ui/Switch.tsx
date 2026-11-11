import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Switch.module.css'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Visible label. Without it, pass `aria-label`. */
  label?: ReactNode
  'aria-label'?: string
  disabled?: boolean
  id?: string
  className?: string
}

export function Switch({ checked, onChange, label, 'aria-label': ariaLabel, disabled, id, className }: SwitchProps) {
  return (
    <label className={cx(styles.wrap, disabled && styles.disabled, className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        disabled={disabled}
        className={styles.track}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.thumb} />
      </button>
      {label && <span className={styles.label}>{label}</span>}
    </label>
  )
}
