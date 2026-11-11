import { Search, X } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cx } from './cx'
import styles from './Input.module.css'

export interface SearchInputProps
  extends Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'aria-label'> {
  value: string
  onChange: (value: string) => void
  /** Accessible name. Default "Search". */
  label?: string
}

export function SearchInput({ value, onChange, label = 'Search', placeholder, className, ...rest }: SearchInputProps) {
  return (
    <div className={cx(styles.search, className)}>
      <Search size={14} className={styles.searchIcon} aria-hidden="true" />
      <input
        {...rest}
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder ?? `${label}…`}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          rest.onKeyDown?.(event)
          if (event.key === 'Escape' && value) {
            event.preventDefault()
            onChange('')
          }
        }}
        className={cx(styles.control, styles.input, styles.searchInput)}
      />
      {value && (
        <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => onChange('')}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
