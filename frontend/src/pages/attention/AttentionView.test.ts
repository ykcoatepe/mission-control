// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import type { ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AttentionView from './AttentionView'
import type { ApiMeta, LoopsData } from './types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const META: ApiMeta = { ok: true, stale: false, observedAt: new Date().toISOString(), ageMs: 0, error: null }
const DAY = 86_400_000

const SAHIL_KEY = 'finding:sahil:BINDING_DEAD:0123456789ab'
const BETA_KEY = 'finding:beta:ROUND_CAP_REACHED:ba9876543210'

const DATA: LoopsData = {
  observedAt: META.observedAt,
  totals: { projects: 2, openFindings: 121, pendingConfirmations: 74, overdueConfirmations: 21 },
  projects: [
    { id: 'argus', restricted: true, openFindings: 117, pendingConfirmations: 74, overdueConfirmations: 21 },
    { id: 'calm', restricted: true, openFindings: 4, pendingConfirmations: 0, overdueConfirmations: 0 },
  ],
  attention: [
    { project: 'argus', kind: 'restricted', restricted: true, severity: 'error', count: 117 },
    {
      project: 'sahil',
      kind: 'finding',
      severity: 'error',
      code: 'BINDING_DEAD',
      subject: 'self',
      detail: null,
      summary:
        'codex/01a1a0b8-ee6e-7473-b1ac-a0e46370ff66 silent since 2026-11-03T09:25:15+00:00 (rotated session?); managers self: mloop --project sahil unbind --host codex --session NEW && mloop --project sahil bind --name x',
      at: '2026-11-03T09:25:15Z',
      key: SAHIL_KEY,
      ackable: true,
      ack: null,
    },
    {
      project: 'beta',
      kind: 'finding',
      severity: 'warning',
      code: 'ROUND_CAP_REACHED',
      subject: 'r3',
      detail: null,
      summary: 'Round limit reached for the dashboard work',
      at: '2026-11-04T09:25:15Z',
      key: BETA_KEY,
      ackable: true,
      ack: { kind: 'ack', at: '2026-11-10T08:30:00Z', until: null },
    },
    {
      project: 'gamma',
      kind: 'finding',
      severity: 'info',
      code: 'GUEST_PUSH_UNSEEN',
      subject: 'g1',
      detail: null,
      summary: 'Message sent to a guest, not seen yet',
      at: '2026-11-05T09:25:15Z',
      key: 'finding:gamma:GUEST_PUSH_UNSEEN:aaaaaaaaaaaa',
      ackable: false,
      ack: null,
    },
  ],
}

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | null
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Records every request; `reply` decides the answer for a write. */
function stubFetch(reply: (call: Call) => Response = () => json(200, { ok: true })) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost')
      const call: Call = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      }
      calls.push(call)
      return call.method === 'GET' ? json(200, {}) : reply(call)
    }),
  )
  return calls
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mount(data: LoopsData = DATA, attention: ComponentProps<typeof AttentionView>['attention'] = null) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(AttentionView, { data, meta: META, attention, refreshError: null, onRetry: () => undefined }),
        ),
      ),
    ),
  )
  return { host, root }
}

const block = (host: HTMLElement, title: string) =>
  [...host.querySelectorAll('section')].find((section) => section.querySelector('h2')?.textContent === title) ?? null

const rowOf = (host: HTMLElement | Element, text: string) =>
  [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(text)) ?? null

const buttonIn = (scope: Element | null, label: string) =>
  [...(scope?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined

async function click(element: Element | undefined | null) {
  expect(element).toBeTruthy()
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('AttentionView groups by acknowledgement', () => {
  it('lists unacknowledged ackable items as New, with Acknowledge and Shelve…, and nothing acknowledged', async () => {
    stubFetch()
    const { host, root } = await mount()
    const fresh = block(host, 'New')!
    expect(fresh).not.toBeNull()
    expect(fresh.textContent).toContain('sahil')
    expect(fresh.textContent).not.toContain('beta')
    expect(fresh.textContent).not.toContain('gamma')
    const row = rowOf(fresh, 'sahil')!
    expect(buttonIn(row, 'Acknowledge')).toBeTruthy()
    expect(buttonIn(row, 'Shelve…')).toBeTruthy()
    await act(async () => root.unmount())
  })

  it('folds Standing by default with its count, and shows when it was acknowledged and an Undo when opened', async () => {
    stubFetch()
    const { host, root } = await mount()
    const standing = block(host, 'Standing')!
    expect(standing.textContent).toContain('1')
    // Folded: the acknowledged row is not on the page.
    expect(host.textContent).not.toContain('Round limit reached for the dashboard work')
    const toggle = buttonIn(standing, 'Show')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await click(toggle)
    const row = rowOf(block(host, 'Standing')!, 'beta')!
    expect(row.textContent).toContain('Acknowledged')
    expect(row.textContent).toMatch(/Acknowledged .*10 Nov|Acknowledged .*\d{2}:\d{2}/)
    expect(buttonIn(row, 'Undo')).toBeTruthy()
    expect(buttonIn(row, 'Acknowledge')).toBeUndefined()
    expect(buttonIn(block(host, 'Standing'), 'Hide')?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => root.unmount())
  })

  it('says until when a shelved item is silenced, or that it stays until undone', async () => {
    stubFetch()
    const until = new Date(Date.now() + 3 * DAY).toISOString()
    const data: LoopsData = {
      ...DATA,
      attention: [
        { ...(DATA.attention[2] as object), ack: { kind: 'shelve', at: new Date().toISOString(), until } },
        { ...(DATA.attention[1] as object), ack: { kind: 'shelve', at: new Date().toISOString(), until: null } },
      ] as LoopsData['attention'],
    }
    const { host, root } = await mount(data)
    await click(buttonIn(block(host, 'Standing'), 'Show'))
    const standing = block(host, 'Standing')!
    expect(rowOf(standing, 'beta')!.textContent).toContain('Shelved until')
    expect(rowOf(standing, 'sahil')!.textContent).toContain('Shelved until you undo')
    await act(async () => root.unmount())
  })

  it('lists an open item that does not count as "Also open", without controls', async () => {
    stubFetch()
    const { host, root } = await mount()
    const other = block(host, 'Also open')!
    const row = rowOf(other, 'gamma')!
    expect(row).toBeTruthy()
    expect(row.querySelector('button')).toBeNull()
    await act(async () => root.unmount())
  })
})

describe('AttentionView alarm line and calm sentence', () => {
  it('summarises the worst new item with the one action, and the action acknowledges that item', async () => {
    const calls = stubFetch()
    const { host, root } = await mount()
    const alarm = host.querySelector('[role="alert"]') as HTMLElement
    expect(alarm.textContent).toContain('Critical')
    expect(alarm.textContent).toContain('sahil: Session stopped answering')
    expect(alarm.querySelectorAll('button')).toHaveLength(1)
    await click(buttonIn(alarm, 'Acknowledge'))
    const post = calls.find((call) => call.method === 'POST')!
    expect(post.path).toBe('/api/attention/acks')
    expect(post.body).toEqual({ key: SAHIL_KEY, kind: 'ack' })
    await act(async () => root.unmount())
  })

  it('shows one quiet sentence and no alarm line when nothing is new', async () => {
    stubFetch()
    const data: LoopsData = { ...DATA, attention: [DATA.attention[2], DATA.attention[3]] }
    const { host, root } = await mount(data)
    expect(host.textContent).toContain('Nothing new needs you.')
    expect(host.querySelector('[role="alert"], [role="status"]')).toBeNull()
    expect(block(host, 'New')).toBeNull()
    // The standing group is still there.
    expect(block(host, 'Standing')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('does not claim calm when the shell counts new items the list does not show', async () => {
    stubFetch()
    const data: LoopsData = { ...DATA, attention: [DATA.attention[2]] }
    const { host, root } = await mount(data, {
      count: 2,
      breakdown: null,
      standing: 1,
      restricted: null,
      state: 'warning',
    })
    expect(host.textContent).not.toContain('Nothing new needs you.')
    expect(host.textContent).toContain('2 need attention')
    await act(async () => root.unmount())
  })
})

describe('AttentionView acknowledge, shelve and undo', () => {
  it('Acknowledge on a row posts the key and the ack kind, with no until', async () => {
    const calls = stubFetch()
    const { host, root } = await mount()
    await click(buttonIn(rowOf(block(host, 'New')!, 'sahil'), 'Acknowledge'))
    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ key: SAHIL_KEY, kind: 'ack' })
    await act(async () => root.unmount())
  })

  it('Shelve… offers 7 days, 30 days and until I undo, and each sends the right until', async () => {
    const calls = stubFetch()
    const { host, root } = await mount()
    const labels = async () => {
      await click(buttonIn(rowOf(block(host, 'New')!, 'sahil'), 'Shelve…'))
      return [...rowOf(block(host, 'New')!, 'sahil')!.querySelectorAll('button')].map((b) => b.textContent?.trim())
    }
    expect(await labels()).toEqual(['7 days', '30 days', 'Until I undo', 'Cancel'])

    const before = Date.now()
    await click(buttonIn(rowOf(block(host, 'New')!, 'sahil'), '7 days'))
    await click(buttonIn(rowOf(block(host, 'New')!, 'sahil'), '30 days'))
    await click(buttonIn(rowOf(block(host, 'New')!, 'sahil'), 'Until I undo'))
    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(3)
    for (const post of posts) {
      expect(post.body?.key).toBe(SAHIL_KEY)
      expect(post.body?.kind).toBe('shelve')
    }
    const within = (value: unknown, days: number) => {
      const ms = Date.parse(String(value))
      return ms >= before + days * DAY && ms <= Date.now() + days * DAY
    }
    expect(within(posts[0].body?.until, 7)).toBe(true)
    expect(within(posts[1].body?.until, 30)).toBe(true)
    expect(posts[2].body).toHaveProperty('until', null)
    await act(async () => root.unmount())
  })

  it('Cancel closes the shelve options without sending anything', async () => {
    const calls = stubFetch()
    const { host, root } = await mount()
    await click(buttonIn(rowOf(block(host, 'New')!, 'sahil'), 'Shelve…'))
    await click(buttonIn(rowOf(block(host, 'New')!, 'sahil'), 'Cancel'))
    expect(buttonIn(rowOf(block(host, 'New')!, 'sahil'), 'Acknowledge')).toBeTruthy()
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
    await act(async () => root.unmount())
  })

  it('Undo deletes the acknowledgement, with the key encoded in the path', async () => {
    const calls = stubFetch()
    const { host, root } = await mount()
    await click(buttonIn(block(host, 'Standing'), 'Show'))
    await click(buttonIn(rowOf(block(host, 'Standing')!, 'beta'), 'Undo'))
    const del = calls.find((call) => call.method === 'DELETE')!
    expect(del.path).toBe(`/api/attention/acks/${encodeURIComponent(BETA_KEY)}`)
    expect(del.path).toContain('%3A')
    await act(async () => root.unmount())
  })

  it('shows the server message next to the control on an error, and the row stays with its controls usable', async () => {
    stubFetch((call) =>
      call.method === 'POST'
        ? json(409, { error: { code: 'not_ackable', message: 'This item does not count any more.' } })
        : json(200, { ok: true }),
    )
    const { host, root } = await mount()
    await click(buttonIn(rowOf(block(host, 'New')!, 'sahil'), 'Acknowledge'))
    const row = rowOf(block(host, 'New')!, 'sahil')!
    expect(row.textContent).toContain('This item does not count any more.')
    expect(row.querySelector('[role="alert"]')?.textContent).toContain('This item does not count any more.')
    // Nothing moved: still New, never optimistic, and the buttons work again.
    expect(buttonIn(row, 'Acknowledge')?.disabled).toBe(false)
    expect(block(host, 'Standing')!.textContent).toContain('1')
    await act(async () => root.unmount())
  })

  it('shows the error of an undo next to the Undo button and keeps the row standing', async () => {
    stubFetch((call) =>
      call.method === 'DELETE' ? json(404, { error: { code: 'ack_not_found', message: 'No such acknowledgement.' } }) : json(200, {}),
    )
    const { host, root } = await mount()
    await click(buttonIn(block(host, 'Standing'), 'Show'))
    await click(buttonIn(rowOf(block(host, 'Standing')!, 'beta'), 'Undo'))
    const row = rowOf(block(host, 'Standing')!, 'beta')!
    expect(row.textContent).toContain('No such acknowledgement.')
    expect(buttonIn(row, 'Undo')).toBeTruthy()
    await act(async () => root.unmount())
  })

  it('does not open the project drawer when a control is used', async () => {
    stubFetch()
    const { host, root } = await mount()
    await click(buttonIn(rowOf(block(host, 'New')!, 'sahil'), 'Shelve…'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => root.unmount())
  })
})

describe('AttentionView restricted projects', () => {
  it('shows one information row with counts only, and no control for it', async () => {
    stubFetch()
    const { host, root } = await mount()
    const restricted = block(host, 'Restricted')!
    expect(restricted).not.toBeNull()
    expect(restricted.textContent).toContain('2 projects')
    expect(restricted.textContent).toContain('121 open findings')
    expect(restricted.textContent).toContain('74 pending')
    expect(restricted.textContent).toContain('21 overdue')
    expect(restricted.textContent).not.toContain('argus')
    expect(restricted.querySelector('button')).toBeNull()
    // Not in the list of items, so it never gets Acknowledge or Shelve…
    expect(block(host, 'New')!.textContent).not.toContain('argus')
    await act(async () => root.unmount())
  })

  it('keeps an unread count unread and does not add up a partial total', async () => {
    stubFetch()
    const data: LoopsData = {
      ...DATA,
      projects: [
        { id: 'argus', restricted: true, openFindings: 117, pendingConfirmations: null, overdueConfirmations: 0 },
        { id: 'calm', restricted: true, openFindings: 4, pendingConfirmations: 0, overdueConfirmations: 0 },
      ],
    }
    const { host, root } = await mount(data)
    const text = block(host, 'Restricted')!.textContent!
    expect(text).toContain('pending not read')
    expect(text).not.toContain('0 pending')
    await act(async () => root.unmount())
  })
})

describe('AttentionView list', () => {
  it('counts chips in confirmations and findings and offers no chip that filters nothing', async () => {
    stubFetch()
    const data: LoopsData = {
      ...DATA,
      projects: [
        {
          id: 'alpha',
          restricted: false,
          title: 'alpha',
          outcome: null,
          openFindings: { total: 2, bySeverity: { error: 1, warning: 1, info: 0 }, byCode: {} },
          pendingConfirmations: [
            { id: 'c1', unit: 'Check the deploy', verification: null, deadline: '2020-01-01T00:00:00Z', overdue: true, state: 'open', kind: null, dependsOn: null, key: 'confirmation:alpha:c1', ackable: true, ack: null },
          ],
          participants: [],
          lastActivityAt: null,
          errors: [],
        },
      ],
    }
    const { host, root } = await mount(data)
    const chips = [...host.querySelectorAll('[aria-label="Filter the attention list"] button')].map((b) =>
      [...b.childNodes]
        .map((n) => n.textContent?.trim())
        .filter(Boolean)
        .join(' '),
    )
    expect(chips[0]).toBe('All')
    expect(chips).toContain('Overdue confirmations 1')
    expect(chips).toContain('Pending confirmations 1')
    await act(async () => root.unmount())
  })

  it('shows a command in a code block under a plain summary, not in the sentence', async () => {
    stubFetch()
    const { host, root } = await mount()
    const row = rowOf(block(host, 'New')!, 'sahil')!
    expect(row.textContent).toContain('Session stopped answering')
    expect(row.textContent).toContain('BINDING_DEAD')
    const code = row.querySelector('code')
    expect(code?.textContent).toMatch(/^mloop --project sahil unbind/)
    const summary = row.querySelector('span[title]')?.textContent ?? ''
    expect(summary).not.toContain('mloop')
    expect(summary).not.toContain('2026-11-03T')
    expect(summary).toContain('01a1a0b8…')
    await act(async () => root.unmount())
  })

  it('lists an acknowledgeable overdue system with its controls', async () => {
    const calls = stubFetch()
    const data: LoopsData = {
      ...DATA,
      attention: [],
      systems: [{ id: 'hermes', state: 'critical', held: false, failed: false, key: 'system:hermes', ackable: true, ack: null }],
    }
    const { host, root } = await mount(data)
    const row = rowOf(block(host, 'New')!, 'Hermes')!
    expect(row.textContent).toContain('Critical')
    await click(buttonIn(row, 'Acknowledge'))
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ key: 'system:hermes', kind: 'ack' })
    await act(async () => root.unmount())
  })
})

describe('AttentionView: Acknowledge all', () => {
  const finding = (n: number, extra: Record<string, unknown> = {}) => ({
    project: `proj${n}`,
    kind: 'finding',
    severity: 'warning',
    code: 'ROUND_CAP_REACHED',
    subject: `r${n}`,
    detail: null,
    summary: `Round limit reached for work ${n}`,
    at: '2026-11-04T09:25:15Z',
    key: `finding:proj${n}:ROUND_CAP_REACHED:00000000000${n}`,
    ackable: true,
    ack: null,
    ...extra,
  })
  const MANY: LoopsData = {
    ...DATA,
    attention: [
      finding(1),
      finding(2),
      finding(3),
      finding(4, { ack: { kind: 'ack', at: '2026-11-10T08:30:00Z', until: null } }),
      finding(5, { ackable: false }),
    ] as LoopsData['attention'],
  }
  const KEYS = [1, 2, 3].map((n) => `finding:proj${n}:ROUND_CAP_REACHED:00000000000${n}`)
  const posts = (calls: Call[]) => calls.filter((call) => call.method === 'POST')

  it('sits in the header of the New block with the number of items it will acknowledge', async () => {
    stubFetch()
    const { host, root } = await mount(MANY)
    expect(buttonIn(block(host, 'New'), 'Acknowledge all (3)')).toBeTruthy()
    await act(async () => root.unmount())
  })

  it('is not offered for a single new item, or when there is nothing to acknowledge', async () => {
    stubFetch()
    const one = await mount({ ...MANY, attention: [finding(1)] as LoopsData['attention'] })
    expect(one.host.textContent).not.toContain('Acknowledge all')
    await act(async () => one.root.unmount())
    const none = await mount({ ...MANY, attention: [finding(5, { ackable: false })] as LoopsData['attention'] })
    expect(none.host.textContent).not.toContain('Acknowledge all')
    await act(async () => none.root.unmount())
  })

  it('asks first, says how many and that a change alerts again, and sends nothing before the answer', async () => {
    const calls = stubFetch()
    const { host, root } = await mount(MANY)
    await click(buttonIn(block(host, 'New'), 'Acknowledge all (3)'))
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement
    expect(dialog.textContent).toContain('3 items')
    expect(dialog.textContent).toContain('alerts you again')
    expect(posts(calls)).toHaveLength(0)
    await click(buttonIn(dialog, 'Cancel'))
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(posts(calls)).toHaveLength(0)
    await act(async () => root.unmount())
  })

  it('acknowledges every ackable new item, one request after the other, then reads the lists again', async () => {
    const calls = stubFetch()
    const invalidated = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    const { host, root } = await mount(MANY)
    await click(buttonIn(block(host, 'New'), 'Acknowledge all (3)'))
    await click(buttonIn(document.querySelector('[role="alertdialog"]'), 'Acknowledge 3'))
    expect(posts(calls).map((call) => call.body)).toEqual(KEYS.map((key) => ({ key, kind: 'ack' })))
    expect(posts(calls).every((call) => call.path === '/api/attention/acks')).toBe(true)
    // The signals and the loops reading are asked again, once, after the last request.
    expect(invalidated).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    invalidated.mockRestore()
    await act(async () => root.unmount())
  })

  it('stops at the first error, says how far it got with the server words, and does not try the rest', async () => {
    const invalidated = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    const calls = stubFetch((call) =>
      call.body?.key === KEYS[1] ? json(409, { error: { code: 'conflict', message: 'The ledger is busy' } }) : json(200, { ok: true }),
    )
    const { host, root } = await mount(MANY)
    await click(buttonIn(block(host, 'New'), 'Acknowledge all (3)'))
    await click(buttonIn(document.querySelector('[role="alertdialog"]'), 'Acknowledge 3'))
    expect(posts(calls).map((call) => call.body?.key)).toEqual([KEYS[0], KEYS[1]])
    const alert = host.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain('Acknowledged 1 of 3')
    expect(alert.textContent).toContain('The ledger is busy')
    // What was accepted is read again.
    expect(invalidated).toHaveBeenCalledTimes(2)
    invalidated.mockRestore()
    await act(async () => root.unmount())
  })
})
