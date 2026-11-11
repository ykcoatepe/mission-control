import { useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { cx } from './cx'
import { resolveTab } from './tabsUtil'
import type { TabItem } from './tabsUtil'
import styles from './Tabs.module.css'

export type { TabItem }

export interface TabsProps {
  tabs: TabItem[]
  /** Accessible name of the tab list. */
  ariaLabel: string
  /** Controlled mode: the active tab id. */
  value?: string
  onChange?: (id: string) => void
  /**
   * URL mode: keep the active tab in this query parameter (e.g. `tab`). The
   * first tab (or `defaultValue`) is the default and is omitted from the URL.
   */
  queryParam?: string
  defaultValue?: string
  className?: string
}

export function Tabs({ tabs, ariaLabel, value, onChange, queryParam, defaultValue, className }: TabsProps) {
  const baseId = useId()
  const [params, setParams] = useSearchParams()
  const listRef = useRef<HTMLDivElement>(null)
  const defaultId = resolveTab(tabs, defaultValue)
  const active = queryParam
    ? resolveTab(tabs, params.get(queryParam), defaultId)
    : resolveTab(tabs, value, defaultId)

  const select = (id: string) => {
    if (queryParam) {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (id === defaultId) next.delete(queryParam)
          else next.set(queryParam, id)
          return next
        },
        { replace: true },
      )
    }
    onChange?.(id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const enabled = tabs.filter((tab) => !tab.disabled)
    const index = enabled.findIndex((tab) => tab.id === active)
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % enabled.length
    if (event.key === 'ArrowLeft') next = (index - 1 + enabled.length) % enabled.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = enabled.length - 1
    event.preventDefault()
    const target = enabled[next]
    if (!target) return
    select(target.id)
    listRef.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(target.id)}"]`)?.focus()
  }

  return (
    <div ref={listRef} role="tablist" aria-label={ariaLabel} className={cx(styles.list, className)} onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            id={`${baseId}-${tab.id}`}
            data-tab={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            className={styles.tab}
            onClick={() => select(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined && <span className={styles.count}>{tab.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
