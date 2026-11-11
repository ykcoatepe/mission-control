// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/ui'
import { unnamedControls } from '../components/ui/a11y.testkit'
import { STALE_WRITE_NOTE } from '../lib/writes'
import Settings from './Settings'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const STALE = { ok: false, stale: true, error: { code: 'openclaw_read_pending', message: 'catching up' } }

interface Server {
  routing: Record<string, unknown>
  heartbeat: Record<string, unknown>
}

/** Keeps state. After a write, reads wait for `release()`: until then the page has only the write's answer. */
function stub(state: Server, onWrite: (path: string, state: Server) => Response) {
  const reads: string[] = []
  let gate: Promise<void> | null = null
  let open: () => void = () => undefined
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, 'http://localhost').pathname
    if ((init?.method ?? 'GET') !== 'GET') {
      gate = new Promise<void>((resolve) => { open = resolve })
      return onWrite(path, state)
    }
    reads.push(path)
    if (path === '/api/models') return json([{ id: 'a/b', name: 'A B' }, { id: 'c/d', name: 'C D' }])
    if (gate && (path === '/api/settings/model-routing' || path === '/api/settings/heartbeat')) await gate
    if (path === '/api/settings/model-routing') return json(state.routing)
    if (path === '/api/settings/heartbeat') return json(state.heartbeat)
    if (path === '/api/settings') return json({ gateway_port: 18789, system: {} })
    return json({ error: { code: 'not_found', message: 'No API route' } }, 404)
  }))
  return { reads, release: () => open() }
}

const ROUTING = { main: 'a/b', subagent: null, heartbeat: null, mainSource: 'set', subagentSource: 'unset', heartbeatSource: 'unset' }

async function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(ToastProvider, null, createElement(Settings)))),
  )
  await settle()
  return { host, root }
}
/** Waits (inside act) until the condition holds, for the reads that follow a released gate. */
async function until(condition: () => boolean) {
  for (let i = 0; i < 40 && !condition(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const labelFor = (host: HTMLElement, text: string) => [...host.querySelectorAll('label')].find((l) => l.textContent === text) as HTMLLabelElement
const select = (host: HTMLElement, text: string) => host.querySelector(`#${labelFor(host, text).htmlFor}`) as HTMLSelectElement
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement
async function choose(input: HTMLSelectElement, value: string) {
  await act(async () => {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Settings: a save is on screen before the refetch lands', () => {
  it('every button on the page has a name', async () => {
    stub({ routing: ROUTING, heartbeat: { interval: '1h' } }, () => json({ status: 'saved' }))
    const { host, root } = await mount()
    expect(unnamedControls(host)).toEqual([])
    await act(async () => root.unmount())
  })

  it('model routing: shows what the server committed and clears the draft; says when the reading is behind', async () => {
    const s = stub({ routing: ROUTING, heartbeat: { interval: '1h' } }, (path, st) => {
      st.routing = { ...ROUTING, main: 'c/d' }
      return path === '/api/settings/model-routing' ? json({ status: 'saved', ...st.routing, meta: STALE }) : json({})
    })
    const { host, root } = await mount()
    expect(host.textContent).not.toContain(STALE_WRITE_NOTE)
    await choose(select(host, 'Main model'), 'c/d')
    await act(async () => button(host, 'Save routing').click())
    await settle()
    expect(select(host, 'Main model').value).toBe('c/d')
    expect(button(host, 'Save routing').disabled).toBe(true)
    expect(host.textContent).toContain(STALE_WRITE_NOTE)
    s.release()
    await settle()
    expect(select(host, 'Main model').value).toBe('c/d')
    await act(async () => root.unmount())
  })

  it('model routing: a later server reading wins over what this page remembers', async () => {
    const state: Server = { routing: ROUTING, heartbeat: { interval: '1h' } }
    const s = stub(state, (path, st) => {
      st.routing = { ...ROUTING, main: 'c/d' }
      return path === '/api/settings/model-routing' ? json({ status: 'saved', ...st.routing }) : json({})
    })
    const { host, root } = await mount()
    await choose(select(host, 'Main model'), 'c/d')
    await act(async () => button(host, 'Save routing').click())
    await settle()
    expect(select(host, 'Main model').value).toBe('c/d')
    // Someone changed it elsewhere before the refetch landed: the page follows the server, not its own memory.
    state.routing = { ...ROUTING, main: 'a/b' }
    s.release()
    await until(() => select(host, 'Main model').value === 'a/b')
    expect(select(host, 'Main model').value).toBe('a/b')
    await act(async () => root.unmount())
  })

  it('heartbeat: the saved interval shows at once', async () => {
    const s = stub({ routing: ROUTING, heartbeat: { interval: '1h' } }, (path, st) => {
      st.heartbeat = { interval: '30m' }
      return path === '/api/settings/heartbeat' ? json({ status: 'saved', interval: '30m', meta: STALE }) : json({})
    })
    const { host, root } = await mount()
    await choose(select(host, 'Check interval'), '30m')
    await act(async () => button(host, 'Save interval').click())
    await settle()
    expect(select(host, 'Check interval').value).toBe('30m')
    expect(host.textContent).toContain('Currently every 30 minutes')
    expect(button(host, 'Save interval').disabled).toBe(true)
    expect(host.textContent).toContain(STALE_WRITE_NOTE)
    s.release()
    await act(async () => root.unmount())
  })

  it('import: reads every setting again', async () => {
    const s = stub({ routing: ROUTING, heartbeat: { interval: '1h' } }, () => json({ status: 'imported', message: 'Restart required.' }))
    const { host, root } = await mount()
    const before = s.reads.filter((path) => path === '/api/settings/model-routing').length
    const input = host.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File(['{}'], 'mc-config.json')], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    s.release()
    await until(() => s.reads.filter((path) => path === '/api/settings/model-routing').length > before)
    expect(s.reads.filter((path) => path === '/api/settings/model-routing').length).toBeGreaterThan(before)
    expect(s.reads.filter((path) => path === '/api/settings/heartbeat').length).toBeGreaterThan(1)
    expect(host.textContent).toContain('Restart required')
    await act(async () => root.unmount())
  })
})

describe('Settings: verified writes (model routing and heartbeat)', () => {

  /** The four answers a model routing write can get. */
  const BEFORE = { ...ROUTING, main: 'a/b' }

  it('verified: the confirmed model shows at once, with no warning', async () => {
    const s = stub({ routing: BEFORE, heartbeat: { interval: '1h' } }, (_path, st) => {
      st.routing = { ...BEFORE, main: 'c/d' }
      return json({ status: 'saved', ...st.routing, verified: true, entity: { main: 'c/d', verified: true }, meta: { ok: true, stale: false } })
    })
    const { host, root } = await mount()
    await choose(select(host, 'Main model'), 'c/d')
    await act(async () => button(host, 'Save routing').click())
    await settle()
    expect(select(host, 'Main model').value).toBe('c/d')
    expect(host.textContent).not.toContain('Sent, not yet confirmed')
    s.release()
    await act(async () => root.unmount())
  })

  it('sent but not confirmed: a warning, and the select shows what the system reports, not the request', async () => {
    const s = stub({ routing: BEFORE, heartbeat: { interval: '1h' } }, (_path, st) =>
      // Nothing was promoted: the answer carries the previous model.
      json({ status: 'unverified', ...st.routing, verified: false, entity: { main: 'a/b', verified: false }, meta: STALE }),
    )
    const { host, root } = await mount()
    await choose(select(host, 'Main model'), 'c/d')
    await act(async () => button(host, 'Save routing').click())
    await settle()
    expect(select(host, 'Main model').value).toBe('a/b')
    expect(host.textContent).toContain('Sent, not yet confirmed')
    expect(host.textContent).not.toContain(STALE_WRITE_NOTE)
    expect(document.querySelector('[data-tone="success"]')).toBeNull()
    expect(document.querySelector('[data-tone="warning"]')).not.toBeNull()
    s.release()
    await settle()
    expect(select(host, 'Main model').value).toBe('a/b')
    await act(async () => root.unmount())
  })

  for (const code of ['upstream_rejected', 'upstream_unverified'] as const) {
    it(`409 ${code}: the message is an error next to the field, and the refused value is gone`, async () => {
      const message = code === 'upstream_rejected'
        ? 'OpenClaw reports main as a/b; the requested change was not accepted'
        : 'OpenClaw returned an unreadable configuration; the change could not be verified'
      const s = stub({ routing: BEFORE, heartbeat: { interval: '1h' } }, () => json({ error: { code, message } }, 409))
      const { host, root } = await mount()
      const readsBefore = s.reads.filter((path) => path === '/api/settings/model-routing').length
      await choose(select(host, 'Main model'), 'c/d')
      await act(async () => button(host, 'Save routing').click())
      await settle()
      const describedBy = select(host, 'Main model').getAttribute('aria-describedby') ?? ''
      const near = describedBy.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
      expect(near).toContain(message)
      expect(select(host, 'Main model').value).toBe('a/b')
      expect(s.reads.filter((path) => path === '/api/settings/model-routing').length).toBeGreaterThan(readsBefore)
      s.release()
      await act(async () => root.unmount())
    })
  }

  it('heartbeat: unconfirmed keeps the previous interval and warns; a refusal shows the message', async () => {
    let answer: () => Response = () => json({ status: 'unverified', interval: '1h', verified: false, entity: { interval: '1h', verified: false }, meta: STALE })
    const s = stub({ routing: ROUTING, heartbeat: { interval: '1h' } }, () => answer())
    const { host, root } = await mount()
    await choose(select(host, 'Check interval'), '30m')
    await act(async () => button(host, 'Save interval').click())
    await settle()
    expect(select(host, 'Check interval').value).toBe('1h')
    expect(host.textContent).toContain('Sent, not yet confirmed')

    answer = () => json({ error: { code: 'upstream_rejected', message: 'OpenClaw reports interval as 1h; the requested change was not accepted' } }, 409)
    await choose(select(host, 'Check interval'), '30m')
    await act(async () => button(host, 'Save interval').click())
    await settle()
    expect(host.textContent).toContain('OpenClaw reports interval as 1h')
    expect(select(host, 'Check interval').value).toBe('1h')
    s.release()
    await act(async () => root.unmount())
  })
})
