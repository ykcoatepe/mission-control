// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/hooks'
import EntryDialog from './EntryDialog'
import type { EntryChange } from './EntryDialog'
import type { CalendarEntry } from './scheduleLib'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const linked: CalendarEntry = {
  id: 'cron-openclaw:daily',
  title: 'Renamed by me',
  schedule: '0 8 * * *',
  startsAt: '2026-11-12T08:00:00.000Z',
  status: 'active',
  assignee: 'Mudur',
  source: 'cron',
  linkedTaskId: null,
  linkedJobId: 'openclaw:daily',
  notes: '',
  userOverrides: ['title'],
  cronDerived: { title: 'daily-digest', schedule: '0 8 * * *', notes: '', assignee: 'Mudur' },
}

const manual: CalendarEntry = {
  id: 'entry-1',
  title: 'Dentist',
  schedule: '',
  startsAt: '2026-11-12T09:00:00.000Z',
  status: 'scheduled',
  assignee: 'Yordam',
  source: 'manual',
  linkedTaskId: null,
  linkedJobId: null,
  notes: '',
}

async function open(entry: CalendarEntry | null, onSave: (change: EntryChange) => Promise<void>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(createElement(MemoryRouter, null, createElement(EntryDialog, { entry, onSave, onClose: vi.fn() }))),
  )
  return root
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement
const labelled = (text: string) =>
  [...dialog().querySelectorAll('label')].find((label) => label.textContent === text) as HTMLLabelElement | undefined
const field = (text: string) => dialog().querySelector(`#${labelled(text)?.htmlFor}`) as HTMLInputElement

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function save() {
  await act(async () => {
    dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('EntryDialog for a scheduler-linked entry', () => {
  it('shows status and next run as read-only facts with a pointer to the Jobs switch', async () => {
    const root = await open(linked, vi.fn())
    expect(labelled('Status')).toBeUndefined()
    expect(labelled('Starts at')).toBeUndefined()
    expect(dialog().textContent).toContain('Status and next run come from the scheduler')
    expect(dialog().querySelector('a')?.getAttribute('href')).toBe('/automations?view=jobs&job=openclaw%3Adaily')
    expect(dialog().textContent).toContain('Statusactive')
    await act(async () => root.unmount())
  })

  it('sends only the edited overridable field, never status, start time or id', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const root = await open(linked, onSave)
    await type(field('Cron schedule'), '30 8 * * *')
    await save()
    expect(onSave).toHaveBeenCalledOnce()
    const change = onSave.mock.calls[0][0] as EntryChange
    expect(change).toEqual({ kind: 'update', id: 'cron-openclaw:daily', patch: { schedule: '30 8 * * *' } })
    expect(Object.keys((change as { patch: object }).patch).some((key) => ['status', 'startsAt', 'id'].includes(key))).toBe(false)
    await act(async () => root.unmount())
  })

  it('offers "Reset to schedule value" only on an overridden field, and sends null for it', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const root = await open(linked, onSave)
    const resets = [...dialog().querySelectorAll('button')].filter((b) => b.textContent === 'Reset to schedule value')
    expect(resets).toHaveLength(1)
    expect(dialog().textContent).toContain('Schedule value: daily-digest')
    await act(async () => resets[0].click())
    expect(field('Title').value).toBe('daily-digest')
    expect(dialog().textContent).toContain('Will return to the schedule value when you save.')
    await save()
    expect(onSave.mock.calls[0][0]).toEqual({ kind: 'update', id: 'cron-openclaw:daily', patch: { title: null } })
    await act(async () => root.unmount())
  })

  it('keeps the dialog open and shows the server message when the server refuses', async () => {
    const onSave = vi.fn().mockRejectedValue(new ApiError({ status: 409, code: 'calendar_override_unavailable', message: 'Sync cron before clearing a legacy override' }))
    const root = await open(linked, onSave)
    await type(field('Title'), 'Another name')
    await save()
    expect(dialog().textContent).toContain('Not saved')
    expect(dialog().textContent).toContain('Sync cron before clearing a legacy override')
    await act(async () => root.unmount())
  })
})

describe('EntryDialog for a manual entry', () => {
  it('lets the person change status and start time, and shows source as a fact', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const root = await open(manual, onSave)
    expect(labelled('Status')).toBeDefined()
    expect(labelled('Starts at')).toBeDefined()
    expect(labelled('Source')).toBeUndefined()
    expect(dialog().textContent).not.toContain('Status and next run come from the scheduler')
    await type(field('Title'), 'Dentist at 9')
    await save()
    expect(onSave.mock.calls[0][0]).toEqual({ kind: 'update', id: 'entry-1', patch: { title: 'Dentist at 9' } })
    await act(async () => root.unmount())
  })
})

describe('EntryDialog for a new entry', () => {
  it('offers no job link, never sends an id, and cannot make a cron entry', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const root = await open(null, onSave)
    expect(labelled('Linked job id')).toBeUndefined()
    expect(labelled('Linked job id (optional)')).toBeUndefined()
    const sources = [...dialog().querySelectorAll('select')].flatMap((select) => [...select.options].map((option) => option.value))
    expect(sources).not.toContain('cron')
    await type(field('Title'), 'Review')
    await save()
    const change = onSave.mock.calls[0][0] as EntryChange
    expect(change.kind).toBe('create')
    const payload = (change as { payload: Record<string, unknown> }).payload
    expect(payload).toMatchObject({ title: 'Review', source: 'manual' })
    expect(payload).not.toHaveProperty('id')
    expect(payload).not.toHaveProperty('linkedJobId')
    await act(async () => root.unmount())
  })

  it('does not send an entry without a title', async () => {
    const onSave = vi.fn()
    const root = await open(null, onSave)
    await save()
    expect(onSave).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('Give the entry a title.')
    await act(async () => root.unmount())
  })
})
