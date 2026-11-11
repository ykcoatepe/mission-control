// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/ui'
import ScheduleView from './ScheduleView'
import { repairDescription, repairOffer, repairResultMessage } from './scheduleLib'
import type { CalendarPayload } from './scheduleLib'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const clean: CalendarPayload = {
  entries: [],
  diagnostics: { quarantined: { count: 0, ids: [] }, duplicates: { count: 0, ids: [] } },
  meta: { ok: true, stale: false, error: null, repairAvailable: false },
}
const damaged = (repairAvailable: boolean | undefined): CalendarPayload => ({
  entries: [],
  diagnostics: { quarantined: { count: 2, ids: ['bad-1', null] }, duplicates: { count: 1, ids: ['dup'] } },
  meta: {
    ok: false,
    stale: true,
    error: { code: 'calendar_entries_quarantined', message: 'Malformed calendar entries were quarantined; the file was preserved' },
    ...(repairAvailable === undefined ? {} : { repairAvailable }),
  },
})

interface Write {
  url: string
  method: string
  headers: Headers
  body: unknown
}

function stubServer(initial: CalendarPayload, repair: () => Response | Promise<Response>) {
  const writes: Write[] = []
  const reads: string[] = []
  let payload = initial
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost').pathname
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        reads.push(url)
        return json(payload)
      }
      writes.push({ url, method, headers: new Headers(init?.headers), body: init?.body })
      const response = await repair()
      // A successful repair leaves a clean file behind.
      if (response.ok) payload = clean
      return response
    }),
  )
  return { writes, reads }
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, null, createElement(ToastProvider, null, createElement(ScheduleView))),
      ),
    ),
  )
  await flush()
  return { host, root }
}

const buttons = () => [...document.querySelectorAll('button')]
const byText = (text: string) => buttons().find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined
const alertDialog = () => document.querySelector('[role="alertdialog"]') as HTMLElement | null

const RESULT = {
  ok: true,
  repaired: true,
  counts: { kept: 7, quarantined: 2, duplicates: 1 },
  backupPath: '~/clawd/calendar.json.repair-2026-11-11T13-00-00-000Z-abc.json',
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Repair calendar: when the button appears', () => {
  it('shows it on the notice only when the read says a repair is available', async () => {
    stubServer(damaged(true), () => json(RESULT))
    const { host, root } = await mount()
    expect(host.textContent).toContain('Some schedule rows were set aside')
    expect(byText('Repair calendar')).toBeDefined()
    // One button only, even though there are two notices about the rows.
    expect(buttons().filter((b) => b.textContent === 'Repair calendar')).toHaveLength(1)
    await act(async () => root.unmount())
  })

  it('offers no button when the rows are damaged but repair is not available, or the flag is absent', async () => {
    for (const flag of [false, undefined]) {
      stubServer(damaged(flag), () => json(RESULT))
      const { host, root } = await mount()
      expect(host.textContent).toContain('Some schedule rows were set aside')
      expect(byText('Repair calendar')).toBeUndefined()
      await act(async () => root.unmount())
      document.body.innerHTML = ''
    }
  })

  it('offers no button for a clean calendar', async () => {
    stubServer(clean, () => json(RESULT))
    const { root } = await mount()
    expect(byText('Repair calendar')).toBeUndefined()
    await act(async () => root.unmount())
  })
})

describe('Repair calendar: the confirmation', () => {
  it('says exactly what will happen, in an alert dialog, and sends nothing until confirmed', async () => {
    const { writes } = stubServer(damaged(true), () => json(RESULT))
    const { root } = await mount()
    await act(async () => byText('Repair calendar')?.click())
    const dialog = alertDialog()
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain(
      '2 malformed rows and 1 duplicate row are moved to a backup file next to the calendar. Valid entries are kept.',
    )
    expect(writes).toEqual([])
    await act(async () => root.unmount())
  })

  it('Cancel closes the dialog and sends nothing', async () => {
    const { writes } = stubServer(damaged(true), () => json(RESULT))
    const { root } = await mount()
    await act(async () => byText('Repair calendar')?.click())
    await act(async () => byText('Cancel')?.click())
    await flush()
    expect(alertDialog()).toBeNull()
    expect(writes).toEqual([])
    await act(async () => root.unmount())
  })

  it('Escape closes the dialog and sends nothing', async () => {
    const { writes } = stubServer(damaged(true), () => json(RESULT))
    const { root } = await mount()
    await act(async () => byText('Repair calendar')?.click())
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(alertDialog()).toBeNull()
    expect(writes).toEqual([])
    await act(async () => root.unmount())
  })
})

describe('Repair calendar: confirming', () => {
  it('sends exactly one guarded POST, shows counts and the home-relative backup path, and reads the calendar again', async () => {
    const { writes, reads } = stubServer(damaged(true), () => json(RESULT))
    const { host, root } = await mount()
    const readsBefore = reads.length
    await act(async () => byText('Repair calendar')?.click())
    await act(async () => {
      const buttonsInDialog = [...alertDialog()!.querySelectorAll('button')]
      buttonsInDialog.find((b) => b.textContent === 'Repair calendar')!.click()
    })
    await flush()
    await flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ url: '/api/calendar/repair', method: 'POST' })
    expect(writes[0].headers.get('x-mc-request')).toBe('1')
    expect(writes[0].body).toBeUndefined()
    expect(alertDialog()).toBeNull()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Calendar repaired: 2 malformed rows and 1 duplicate row moved to a backup in ~/clawd/calendar.json.repair-')
    expect(text).toContain('7 valid entries kept.')
    expect(text).not.toMatch(/\/Users\//)
    // The calendar is read again and the notice is gone (the stub now returns a clean file).
    expect(reads.length).toBeGreaterThan(readsBefore)
    expect(host.textContent).not.toContain('Some schedule rows were set aside')
    expect(byText('Repair calendar')).toBeUndefined()
    await act(async () => root.unmount())
  })

  it('shows the server message on a 409 and leaves the dialog open without a second request', async () => {
    const { writes } = stubServer(damaged(true), () =>
      json({ error: { code: 'calendar_unavailable', message: 'Calendar data is unreadable; no changes were made' } }, 409),
    )
    const { root } = await mount()
    await act(async () => byText('Repair calendar')?.click())
    await act(async () => {
      ;[...alertDialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Repair calendar')!.click()
    })
    await flush()
    expect(writes).toHaveLength(1)
    const dialog = alertDialog()
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('Calendar data is unreadable; no changes were made')
    await act(async () => root.unmount())
  })
})

describe('repair wording', () => {
  it('describes the offer in singular and plural, and says nothing about a count that is zero', () => {
    expect(repairDescription({ malformed: 1, duplicates: 0 })).toBe(
      '1 malformed row is moved to a backup file next to the calendar. Valid entries are kept.',
    )
    expect(repairDescription({ malformed: 0, duplicates: 3 })).toBe(
      '3 duplicate rows are moved to a backup file next to the calendar. Valid entries are kept.',
    )
    expect(repairDescription({ malformed: 0, duplicates: 0 })).toContain('The rows the calendar read set aside are moved')
  })

  it('offers a repair only when the read says so', () => {
    expect(repairOffer(null)).toBeNull()
    expect(repairOffer(damaged(false))).toBeNull()
    expect(repairOffer(damaged(undefined))).toBeNull()
    expect(repairOffer(damaged(true))).toEqual({ malformed: 2, duplicates: 1 })
  })

  it('reports an idempotent repair and a malformed reply plainly', () => {
    expect(repairResultMessage({ ok: true, repaired: false, counts: { kept: 1, quarantined: 0, duplicates: 0 }, backupPath: null })).toBe(
      'Nothing needed repair; all 1 entry is valid.',
    )
    expect(repairResultMessage(null)).toBe('The calendar was repaired.')
    expect(repairResultMessage(RESULT)).toContain('~/clawd/calendar.json.repair-')
  })
})
