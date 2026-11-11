import { useId } from 'react'
import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Field.module.css'

export interface FieldControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: true
}

export interface FieldProps {
  label: string
  hint?: ReactNode
  /** Error text. Shown in the critical colour and marks the control invalid. */
  error?: ReactNode
  /** Render prop: spread the given props onto the control. */
  children: (control: FieldControlProps) => ReactNode
  className?: string
}

/** Label + control + hint/error, wired together with ids. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ')
  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {children({
        id,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {error && (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
    </div>
  )
}
