import { describe, expect, it } from 'vitest'
import {
  buildCreatePayload,
  buildUpdatePatch,
  calendarNotices,
  formFromEntry,
  isLinkedEntry,
  jobHref,
  writesBlocked,
} from './scheduleLib'
import type { CalendarEntry, CalendarPayload } from './scheduleLib'

const linked: CalendarEntry = {
  id: 'cron-openclaw:daily',
  title: 'Daily digest',
  schedule: '0 8 * * *',
  startsAt: '2026-11-12T08:00:00.000Z',
  status: 'active',
  assignee: 'Mudur',
  source: 'cron',
  linkedTaskId: null,
  linkedJobId: 'openclaw:daily',
  notes: 'Send the digest',
  userOverrides: ['title'],
  cronDerived: { title: 'daily-digest', schedule: '0 8 * * *', notes: 'Send the digest', assignee: 'Mudur' },
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

const SCHEDULER_OWNED = ['status', 'startsAt', 'nextRun', 'nextRunAt', 'nextRunAtMs']

describe('scheduler-linked entries', () => {
  it('are recognised by source and job link', () => {
    expect(isLinkedEntry(linked)).toBe(true)
    expect(isLinkedEntry(manual)).toBe(false)
    expect(isLinkedEntry({ source: 'cron', linkedJobId: null })).toBe(false)
  })

  it('a PATCH never contains a scheduler-owned field, however the form was changed', () => {
    const form = { ...formFromEntry(linked), status: 'disabled', startsAt: '2030-01-01T00:00:00.000Z', title: 'Renamed', notes: 'Changed' }
    const patch = buildUpdatePatch(linked, form)
    expect(patch).toEqual({ title: 'Renamed', notes: 'Changed' })
    for (const field of SCHEDULER_OWNED) expect(patch).not.toHaveProperty(field)
    expect(patch).not.toHaveProperty('id')
  })

  it('sends only what changed', () => {
    expect(buildUpdatePatch(linked, formFromEntry(linked))).toEqual({})
    expect(buildUpdatePatch(linked, { ...formFromEntry(linked), assignee: 'Yordam' })).toEqual({ assignee: 'Yordam' })
  })

  it('"Reset to schedule value" sends null for an overridden field', () => {
    const form = { ...formFromEntry(linked), title: linked.cronDerived!.title! }
    expect(buildUpdatePatch(linked, form, new Set(['title']))).toEqual({ title: null })
  })

  it('a reset of a field that is not overridden sends nothing', () => {
    expect(buildUpdatePatch(linked, formFromEntry(linked), new Set(['notes']))).toEqual({})
  })

  it('a reset wins over text typed into the same field', () => {
    const form = { ...formFromEntry(linked), title: 'typed after' }
    expect(buildUpdatePatch(linked, form, new Set(['title']))).toEqual({ title: null })
  })

  it('links a person to the job that switches it on and off', () => {
    expect(jobHref(linked)).toBe('/automations?view=jobs&job=openclaw%3Adaily')
    expect(jobHref(manual)).toBeNull()
  })
})

describe('manual entries', () => {
  it('may change status and start time', () => {
    const form = { ...formFromEntry(manual), status: 'done', startsAt: null }
    expect(buildUpdatePatch(manual, form)).toEqual({ status: 'done', startsAt: null })
  })

  it('never send id, source or link fields in a PATCH', () => {
    const form = { ...formFromEntry(manual), source: 'assistant', linkedTaskId: 'task-9', title: 'x' }
    expect(buildUpdatePatch(manual, form)).toEqual({ title: 'x' })
  })
})

describe('create payload', () => {
  const form = { ...formFromEntry(null), title: '  Review  ', linkedTaskId: ' t-1 ', source: 'cron' }

  it('has no id and no job link', () => {
    const payload = buildCreatePayload(form)
    expect(payload).not.toHaveProperty('id')
    expect(payload).not.toHaveProperty('linkedJobId')
  })

  it('cannot create a cron-sourced entry: that is the schedule sync', () => {
    expect(buildCreatePayload(form).source).toBe('manual')
    expect(buildCreatePayload({ ...form, source: 'assistant' }).source).toBe('assistant')
  })

  it('trims text and keeps an empty task link as null', () => {
    expect(buildCreatePayload(form)).toMatchObject({ title: 'Review', linkedTaskId: 't-1' })
    expect(buildCreatePayload({ ...form, linkedTaskId: '  ' }).linkedTaskId).toBeNull()
  })
})

describe('calendarNotices', () => {
  const base: CalendarPayload = { entries: [] }

  it('is silent for a clean read', () => {
    expect(calendarNotices(base)).toEqual([])
    expect(calendarNotices(null)).toEqual([])
    expect(writesBlocked(base)).toBe(false)
  })

  it('reports quarantined rows with their ids and says changes are paused', () => {
    const payload: CalendarPayload = {
      entries: [],
      diagnostics: { quarantined: { count: 2, ids: ['bad-1', 7] }, duplicates: { count: 0, ids: [] } },
      meta: { stale: true, error: { code: 'calendar_entries_quarantined', message: 'Malformed calendar entries were quarantined; the file was preserved' } },
    }
    const [notice, ...rest] = calendarNotices(payload)
    expect(rest).toEqual([])
    expect(notice.title).toBe('Some schedule rows were set aside')
    expect(notice.body).toContain('2 malformed rows were left out (bad-1, 7)')
    expect(notice.body).toContain('paused')
    expect(writesBlocked(payload)).toBe(true)
  })

  it('reports duplicate ids, one notice per cause', () => {
    const payload: CalendarPayload = {
      entries: [],
      diagnostics: { quarantined: { count: 1, ids: [null] }, duplicates: { count: 1, ids: ['dup'] } },
    }
    const notices = calendarNotices(payload)
    expect(notices.map((n) => n.id)).toEqual(['quarantined', 'duplicates'])
    expect(notices[1].body).toContain('only the first row of each is shown')
  })

  it('a stale scheduler is a quiet info notice with the server wording', () => {
    const payload: CalendarPayload = {
      entries: [],
      meta: { stale: true, error: { code: 'calendar_scheduler_stale', message: 'Unavailable scheduler rows were retained from last-good calendar data' } },
    }
    expect(calendarNotices(payload)).toEqual([
      { id: 'calendar_scheduler_stale', tone: 'info', title: 'Schedule may be behind', body: 'Unavailable scheduler rows were retained from last-good calendar data' },
    ])
    expect(writesBlocked(payload)).toBe(false)
  })

  it('does not repeat the data-quality error as a second "stale" notice', () => {
    const payload: CalendarPayload = {
      entries: [],
      diagnostics: { quarantined: { count: 1, ids: ['x'] }, duplicates: { count: 0, ids: [] } },
      meta: { stale: true, error: { code: 'calendar_entries_quarantined', message: 'm' } },
    }
    expect(calendarNotices(payload)).toHaveLength(1)
  })
})
