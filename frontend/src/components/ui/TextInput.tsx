import type { ComponentProps } from 'react'
import { cx } from './cx'
import styles from './Input.module.css'

export interface TextInputProps extends ComponentProps<'input'> {
  invalid?: boolean
}

export function TextInput({ invalid, className, type = 'text', ...rest }: TextInputProps) {
  return (
    <input
      {...rest}
      type={type}
      aria-invalid={invalid || undefined}
      className={cx(styles.control, styles.input, className)}
    />
  )
}
