import { cx } from './cx'
import styles from './FilterChips.module.css'

export interface FilterChipOption {
  value: string
  label: string
  /** Real count only; omit when unknown. */
  count?: number
}

export interface FilterChipsProps {
  options: FilterChipOption[]
  /** One selected value (single mode) or several (multi mode). */
  value: string | string[]
  /** Called with the clicked chip's value. The caller decides whether to select or toggle. */
  onChange: (value: string) => void
  ariaLabel: string
  className?: string
}

export function FilterChips({ options, value, onChange, ariaLabel, className }: FilterChipsProps) {
  const selected = Array.isArray(value) ? value : [value]
  return (
    <div role="group" aria-label={ariaLabel} className={cx(styles.chips, className)}>
      {options.map((option) => {
        const pressed = selected.includes(option.value)
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            className={styles.chip}
            onClick={() => onChange(option.value)}
          >
            {option.label}
            {option.count !== undefined && <span className={styles.count}>{option.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
