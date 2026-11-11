import { ChevronDown } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cx } from './cx'
import styles from './Input.module.css'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends ComponentProps<'select'> {
  /** Options as data; `children` (`<option>`) also work. */
  options?: SelectOption[]
  invalid?: boolean
}

export function Select({ options, invalid, className, children, ...rest }: SelectProps) {
  return (
    <div className={cx(styles.selectWrap, className)}>
      <select {...rest} aria-invalid={invalid || undefined} className={cx(styles.control, styles.select)}>
        {options
          ? options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown size={14} className={styles.chevron} aria-hidden="true" />
    </div>
  )
}
