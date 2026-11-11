import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { cx } from './cx'
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

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  onRowClick,
  selectedKey,
  dimmed,
  empty,
  maxHeight,
  className,
}: DataTableProps<T>) {
  if (rows.length === 0 && empty) {
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
    <div
      className={cx(styles.scroll, className)}
      style={maxHeight ? ({ '--dt-max-h': maxHeight } as CSSProperties) : undefined}
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
                style={column.width ? { width: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row)
            return (
              <tr
                key={key}
                className={cx(
                  onRowClick && styles.clickable,
                  dimmed?.(row) && styles.dimmed,
                  selectedKey === key && styles.selected,
                )}
                tabIndex={onRowClick ? 0 : undefined}
                aria-selected={onRowClick && selectedKey !== undefined ? selectedKey === key : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (event) => onKeyDown(event, row) : undefined}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    data-label={column.mobileLabel ?? (typeof column.header === 'string' ? column.header : '')}
                    className={cx(
                      column.align === 'end' && styles.end,
                      column.mono && styles.mono,
                      column.hideOnMobile && styles.hideMobile,
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
