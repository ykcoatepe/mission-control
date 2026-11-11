import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { cx } from './cx'
import { isEmptyCell } from './dataTableUtil'
import styles from './DataTable.module.css'

export interface DataTableColumn<T> {
  key: string
  header: ReactNode
  /** Cell content for a row. */
  cell: (row: T) => ReactNode
  align?: 'start' | 'end'
  /** Monospace + tabular numerals: ids, cron expressions, counts, money, durations. */
  mono?: boolean
  /** CSS width, e.g. `120px` or `20%`. */
  width?: string
  /** CSS minimum width, e.g. `9rem`. Columns never narrow below their longest word; this raises the floor. */
  minWidth?: string
  /** Label shown before the value when rows stack on narrow screens. Defaults to a string `header`. */
  mobileLabel?: string
  /** Do not show this column when rows stack on narrow screens. */
  hideOnMobile?: boolean
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  /** Accessible name of the table (visually hidden caption). */
  caption: string
  /** Makes rows clickable and keyboard-operable (Enter / Space). */
  onRowClick?: (row: T) => void
  /**
   * Accessible name of a clickable row's action: "<rowLabel>, open details". Without it the name is built from the
   * first column's text plus "open details" (so a screen reader hears what the row is and what Enter does).
   */
  rowLabel?: (row: T) => string
  /**
   * Which rows `onRowClick` applies to. A row for which this returns false is a plain row: not focusable,
   * no pointer cursor, ignored by click and keyboard. Default: every row.
   */
  rowClickable?: (row: T) => boolean
  /** Highlights the row whose key matches. */
  selectedKey?: string | null
  /** Dim a row (paused, disabled, archived). */
  dimmed?: (row: T) => boolean
  /** Shown when `rows` is empty, e.g. an `<EmptyState>`. */
  empty?: ReactNode
  /** CSS max-height of the scroll area (sticky header works inside it). Default fits the viewport. */
  maxHeight?: string
  className?: string
}

const OPEN_DETAILS = 'open details'

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  onRowClick,
  rowLabel,
  rowClickable,
  selectedKey,
  dimmed,
  empty,
  maxHeight,
  className,
}: DataTableProps<T>) {
  const uid = useId()
  const hintId = `${uid}-open`
  const scrollRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false, scrollable: false })
  const showEmpty = rows.length === 0 && Boolean(empty)

  // Which edges have more content behind them: drives the edge fades and keyboard access to the scroll area.
  // Only the observer and scroll callbacks set state (the observer also fires once when it starts observing).
  useEffect(() => {
    const el = scrollRef.current
    if (showEmpty || !el) return
    const update = () => {
      const x = Math.abs(el.scrollLeft)
      const next = {
        start: x > 1,
        end: el.scrollWidth - el.clientWidth - x > 1,
        scrollable: el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1,
      }
      setEdges((prev) => (prev.start === next.start && prev.end === next.end && prev.scrollable === next.scrollable ? prev : next))
    }
    el.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(el)
    if (el.firstElementChild) observer?.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [showEmpty, rows.length, columns.length])

  if (showEmpty) {
    return <div className={cx(styles.empty, className)}>{empty}</div>
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onRowClick?.(row)
    }
  }

  return (
    <div className={cx(styles.wrap, className)} data-edge-start={edges.start || undefined} data-edge-end={edges.end || undefined}>
      {onRowClick && (
        <span id={hintId} hidden>
          {OPEN_DETAILS}
        </span>
      )}
      <div
        ref={scrollRef}
        className={styles.scroll}
        style={maxHeight ? ({ '--dt-max-h': maxHeight } as CSSProperties) : undefined}
        // A scrolling area must be reachable by keyboard; only needed (and only announced) when it scrolls.
        role={edges.scrollable ? 'region' : undefined}
        aria-label={edges.scrollable ? `${caption} (scrollable)` : undefined}
        tabIndex={edges.scrollable ? 0 : undefined}
      >
        <table className={styles.table}>
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cx(column.align === 'end' && styles.end, column.hideOnMobile && styles.hideMobile)}
                  style={column.width || column.minWidth ? { width: column.width, minWidth: column.minWidth } : undefined}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const key = rowKey(row)
              const interactive = Boolean(onRowClick) && (rowClickable ? rowClickable(row) : true)
              const label = interactive ? rowLabel?.(row) : undefined
              const firstCellId = `${uid}-r${rowIndex}-c0`
              return (
                <tr
                  key={key}
                  className={cx(
                    interactive && styles.clickable,
                    dimmed?.(row) && styles.dimmed,
                    selectedKey === key && styles.selected,
                  )}
                  tabIndex={interactive ? 0 : undefined}
                  aria-label={label ? `${label}, ${OPEN_DETAILS}` : undefined}
                  aria-labelledby={interactive && !label ? `${firstCellId} ${hintId}` : undefined}
                  aria-selected={interactive && selectedKey !== undefined ? selectedKey === key : undefined}
                  onClick={interactive ? () => onRowClick?.(row) : undefined}
                  onKeyDown={interactive ? (event) => onKeyDown(event, row) : undefined}
                >
                  {columns.map((column, columnIndex) => {
                    const content = column.cell(row)
                    // A blank cell shows nothing, and in the stacked layout it shows no label either.
                    const blank = isEmptyCell(content)
                    const mobileLabel = column.mobileLabel ?? (typeof column.header === 'string' ? column.header : '')
                    return (
                      <td
                        key={column.key}
                        id={columnIndex === 0 ? firstCellId : undefined}
                        data-label={mobileLabel}
                        data-empty={blank || undefined}
                        style={column.minWidth ? { minWidth: column.minWidth } : undefined}
                        className={cx(
                          column.align === 'end' && styles.end,
                          column.mono && styles.mono,
                          column.hideOnMobile && styles.hideMobile,
                        )}
                      >
                        {blank ? null : content}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <span className={styles.fadeStart} aria-hidden="true" />
      <span className={styles.fadeEnd} aria-hidden="true" />
    </div>
  )
}
