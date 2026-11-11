// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataTable } from './DataTable'
import type { DataTableColumn } from './DataTable'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Row {
  id: string
  restricted: boolean
}

const columns: DataTableColumn<Row>[] = [{ key: 'id', header: 'Id', cell: (row) => row.id }]
const rows: Row[] = [
  { id: 'open', restricted: false },
  { id: 'locked', restricted: true },
]

async function mount(props: { rowClickable?: (row: Row) => boolean; onRowClick?: (row: Row) => void }) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(DataTable<Row>, {
        columns,
        rows,
        rowKey: (row: Row) => row.id,
        caption: 'Rows',
        selectedKey: null,
        ...props,
      }),
    ),
  )
  const trs = [...host.querySelectorAll('tbody tr')] as HTMLTableRowElement[]
  return { host, root, trs }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('DataTable rowClickable', () => {
  it('makes every row interactive when no predicate is given', async () => {
    const onRowClick = vi.fn()
    const { trs, root } = await mount({ onRowClick })
    expect(trs.map((tr) => tr.getAttribute('tabindex'))).toEqual(['0', '0'])
    await act(async () => trs[1].click())
    expect(onRowClick).toHaveBeenCalledWith(rows[1])
    await act(async () => root.unmount())
  })

  it('leaves a non-clickable row unfocusable, without a pointer class, selection state or handler', async () => {
    const onRowClick = vi.fn()
    const { trs, root } = await mount({ onRowClick, rowClickable: (row) => !row.restricted })
    expect(trs[0].getAttribute('tabindex')).toBe('0')
    expect(trs[0].getAttribute('aria-selected')).toBe('false')
    expect(trs[1].hasAttribute('tabindex')).toBe(false)
    expect(trs[1].hasAttribute('aria-selected')).toBe(false)
    expect(trs[1].className).not.toMatch(/clickable/)
    expect(trs[0].className).toMatch(/clickable/)

    await act(async () => trs[1].click())
    await act(async () => {
      trs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onRowClick).not.toHaveBeenCalled()

    await act(async () => trs[0].click())
    expect(onRowClick).toHaveBeenCalledTimes(1)
    expect(onRowClick).toHaveBeenCalledWith(rows[0])
    await act(async () => root.unmount())
  })

  it('does nothing special without onRowClick', async () => {
    const { trs, root } = await mount({ rowClickable: () => true })
    expect(trs.every((tr) => !tr.hasAttribute('tabindex'))).toBe(true)
    await act(async () => root.unmount())
  })
})

describe('kit stylesheet rules', () => {
  const read = (path: string) => readFileSync(join(__dirname, path), 'utf8')

  it('keeps the tab row from scrolling vertically (no stray scrollbar)', () => {
    const css = read('Tabs.module.css')
    const list = css.slice(css.indexOf('.list {'), css.indexOf('}', css.indexOf('.list {')))
    expect(list).toMatch(/overflow-y:\s*hidden/)
    // The selected underline sits inside the tab, so it cannot overflow the row by a pixel.
    expect(css).not.toMatch(/bottom:\s*-1px/)
  })

  it('turns code ligatures off for all text, Mono included', () => {
    const css = read('../../index.css')
    expect(css).toMatch(/body\s*{[^}]*font-variant-ligatures:\s*none/)
    expect(css).toMatch(/\.mono\s*{[^}]*font-variant-ligatures:\s*none/)
  })
})
