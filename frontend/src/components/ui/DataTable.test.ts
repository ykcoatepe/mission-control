// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Fragment, act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataTable } from './DataTable'
import type { DataTableColumn } from './DataTable'
import { isEmptyCell } from './dataTableUtil'

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

describe('DataTable accessibility and empty cells', () => {
  interface Svc {
    id: string
    note: string | null
  }
  const svcColumns: DataTableColumn<Svc>[] = [
    { key: 'id', header: 'Service', cell: (row) => row.id },
    { key: 'note', header: 'Note', cell: (row) => (row.note ? createElement('span', null, row.note) : null) },
    { key: 'blank', header: 'Blank', cell: () => createElement('span', null, '  ') },
  ]
  const svcRows: Svc[] = [
    { id: 'a.service', note: 'Restarted' },
    { id: 'b.service', note: null },
  ]

  async function mountSvc(props: Record<string, unknown>) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(DataTable<Svc>, { columns: svcColumns, rows: svcRows, rowKey: (row: Svc) => row.id, caption: 'Services', ...props }),
      ),
    )
    return { host, root }
  }

  it('flags a blank cell so the stacked layout shows no label for it, and keeps real content', async () => {
    const { host, root } = await mountSvc({})
    const cells = [...host.querySelectorAll('tbody tr:nth-child(2) td')] as HTMLElement[]
    expect(cells[0].hasAttribute('data-empty')).toBe(false)
    expect(cells[1].hasAttribute('data-empty')).toBe(true)
    expect(cells[1].textContent).toBe('')
    const first = [...host.querySelectorAll('tbody tr:nth-child(1) td')] as HTMLElement[]
    expect(first[1].hasAttribute('data-empty')).toBe(false)
    expect(first[1].textContent).toBe('Restarted')
    await act(async () => root.unmount())
  })

  it('treats a dash, zero and other real values as content, not as empty', () => {
    expect(isEmptyCell('—')).toBe(false)
    expect(isEmptyCell(0)).toBe(false)
    expect(isEmptyCell('0')).toBe(false)
    expect(isEmptyCell(createElement('span'))).toBe(false)
    expect(isEmptyCell(null)).toBe(true)
    expect(isEmptyCell(undefined)).toBe(true)
    expect(isEmptyCell(false)).toBe(true)
    expect(isEmptyCell('')).toBe(true)
    expect(isEmptyCell(['', null])).toBe(true)
    expect(isEmptyCell(createElement(Fragment, null, null, ' '))).toBe(true)
    expect(isEmptyCell(createElement(Fragment, null, '—'))).toBe(false)
  })

  it('names a clickable row from rowLabel plus "open details"', async () => {
    const { host, root } = await mountSvc({ onRowClick: () => undefined, rowLabel: (row: Svc) => `Service ${row.id}` })
    const tr = host.querySelector('tbody tr') as HTMLElement
    expect(tr.getAttribute('aria-label')).toBe('Service a.service, open details')
    expect(tr.hasAttribute('aria-labelledby')).toBe(false)
    await act(async () => root.unmount())
  })

  it('without rowLabel the name is the first cell plus "open details", resolved from the DOM', async () => {
    const { host, root } = await mountSvc({ onRowClick: () => undefined })
    const tr = host.querySelector('tbody tr') as HTMLElement
    const ids = (tr.getAttribute('aria-labelledby') ?? '').split(' ')
    expect(ids).toHaveLength(2)
    const text = ids.map((id) => document.getElementById(id)?.textContent).join(' ')
    expect(text).toBe('a.service open details')
    expect(tr.hasAttribute('aria-label')).toBe(false)
    await act(async () => root.unmount())
  })

  it('gives a plain row (no onRowClick, or not clickable) no action name', async () => {
    const { host, root } = await mountSvc({})
    const tr = host.querySelector('tbody tr') as HTMLElement
    expect(tr.hasAttribute('aria-label')).toBe(false)
    expect(tr.hasAttribute('aria-labelledby')).toBe(false)
    await act(async () => root.unmount())
    document.body.innerHTML = ''
    const locked = await mountSvc({ onRowClick: () => undefined, rowClickable: () => false, rowLabel: () => 'x' })
    const row = locked.host.querySelector('tbody tr') as HTMLElement
    expect(row.hasAttribute('aria-label')).toBe(false)
    expect(row.hasAttribute('aria-labelledby')).toBe(false)
    await act(async () => locked.root.unmount())
  })
})

describe('DataTable stylesheet contract', () => {
  const css = readFileSync(join(__dirname, 'DataTable.module.css'), 'utf8')

  it('dims rows by colour, never by opacity (contrast stays at --text-3, at least 4.5:1)', () => {
    const dimmed = css.slice(css.indexOf('.dimmed {'), css.indexOf('.empty {'))
    expect(dimmed).toMatch(/--text-1:\s*var\(--text-3\)/)
    expect(dimmed).not.toMatch(/opacity/)
  })

  it('never breaks a word mid-word in the table layout, only in the stacked layout', () => {
    const table = css.slice(0, css.indexOf('@media'))
    expect(table).not.toMatch(/overflow-wrap:\s*anywhere/)
    expect(table).not.toMatch(/word-break:\s*break-all/)
    expect(css.slice(css.indexOf('@media'))).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it('hides empty cells in the stacked layout even on hover', () => {
    expect(css).toMatch(/td\[data-empty\]\s*{\s*display:\s*none\s*!important/)
  })

  it('fades the scroll edges that have more content', () => {
    expect(css).toMatch(/\[data-edge-end\]\s+\.fadeEnd/)
    expect(css).toMatch(/\[data-edge-start\]\s+\.fadeStart/)
  })
})
