import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { cx } from './cx'
import styles from './SegmentedControl.module.css'

export interface SegmentOption<T extends string = string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  size?: 'sm' | 'md'
  className?: string
}

/** A small mutually exclusive view switch (radio group semantics). */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const ref = useRef<HTMLDivElement>(null)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return
    const enabled = options.filter((option) => !option.disabled)
    const index = enabled.findIndex((option) => option.value === value)
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
    const target = enabled[(index + step + enabled.length) % enabled.length]
    if (!target) return
    event.preventDefault()
    onChange(target.value)
    ref.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(target.value)}"]`)?.focus()
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cx(styles.group, size === 'sm' && styles.sm, className)}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            className={styles.segment}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
