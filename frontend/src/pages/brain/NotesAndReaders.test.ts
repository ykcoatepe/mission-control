// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Synoptic } from './Synoptic'
import { NotesPanel } from './NotesPanel'
import { buildBrainModel, currentNotes, deriveVerdict } from './lib'
import { synoptic, withVerdict } from './fixtures'
import type { IncidentBanner, VerdictReason } from './types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const META = { ok: true, stale: false, observedAt: null, ageMs: 0, error: null } as never

// The server's four reasons for the live reading the owner reported (after the core line was dropped).
const LIVE: VerdictReason[] = [
  { elementId: 'missing-embeddings', state: 'warning', kind: 'action', text: '12 chunks are missing embeddings past the tolerance.' },
  { elementId: 'embed-job-probe', state: 'unavailable', kind: 'info', text: "Embedding job status couldn't be read, so missing embeddings are judged by age only." },
  { elementId: 'tk-omc-ain', state: 'inactive', kind: 'info', text: 'tk-omc-ain: sync off.' },
  { elementId: 'readers', state: 'inactive', kind: 'info', text: "Hermes and Codex are set up. Live connections can't be read from this machine." },
]

const mounted: Array<() => void> = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.()
  document.body.innerHTML = ''
})

async function mount(node: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  mounted.push(() => act(() => root.unmount()) as unknown as void)
  return host
}

const notesFor = (reasons: VerdictReason[]) => currentNotes(deriveVerdict(withVerdict(synoptic(), ...reasons), META))
const panel = (notes: ReturnType<typeof notesFor>) =>
  createElement(NotesPanel, { notes, recovered: [], onAcknowledge: () => undefined })

describe('notes are two groups, split by the server', () => {
  it('puts one thing to act on on top and three for information below', () => {
    const notes = notesFor(LIVE)
    expect(notes.action.map((n) => n.text)).toEqual(['12 chunks are missing embeddings past the tolerance.'])
    expect(notes.info.map((n) => n.id)).toEqual([
      'condition:embed-job-probe',
      'condition:tk-omc-ain',
      'condition:readers',
    ])
  })

  it('follows the server kind, not the state: an unavailable reason marked info is information', () => {
    const notes = notesFor([{ elementId: 'queue', state: 'unavailable', kind: 'action', text: 'Queue reading unavailable.' }, LIVE[1]])
    expect(notes.action.map((n) => n.id)).toEqual(['condition:queue'])
    expect(notes.info.map((n) => n.id)).toEqual(['condition:embed-job-probe'])
  })

  it('reads an older payload without kind: inactive is information, anything else is action', () => {
    const notes = notesFor([
      { elementId: 'queue', state: 'warning', text: 'Queue requires attention.' },
      { elementId: 'off', state: 'inactive', text: 'off: sync disabled.' },
    ])
    expect(notes.action).toHaveLength(1)
    expect(notes.info).toHaveLength(1)
  })

  it('leads the headline with something to act on at equal severity', () => {
    const verdict = deriveVerdict(
      withVerdict(synoptic(), LIVE[1], { elementId: 'missing-embeddings', state: 'unavailable', kind: 'action', text: 'Missing-embedding count unavailable.' }),
      META,
    )
    expect(verdict.text).toBe('GBrain readings are incomplete: Missing-embedding count unavailable (and 1 more)')
  })
})

describe('the Notes card', () => {
  it('shows what needs action and hides the rest behind a disclosure', async () => {
    const host = await mount(panel(notesFor(LIVE)))
    const top = host.querySelector('ul[aria-label="Needs action"]')
    expect(top?.textContent).toBe('12 chunks are missing embeddings past the tolerance.')
    const toggle = host.querySelector('button[aria-expanded]') as HTMLButtonElement
    expect(toggle.textContent).toBe('3 more for information')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    const info = document.getElementById(toggle.getAttribute('aria-controls') ?? '') as HTMLElement
    expect(info.hidden).toBe(true)
    expect(info.querySelector('[data-state]')).toBeNull()
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(info.hidden).toBe(false)
    expect([...info.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      "Embedding job status couldn't be read, so missing embeddings are judged by age only.",
      'tk-omc-ain: sync off.',
      "Hermes and Codex are set up. Live connections can't be read from this machine.",
    ])
  })

  it('says in one quiet line that there is nothing to act on when only information is left', async () => {
    const host = await mount(panel(notesFor(LIVE.slice(2))))
    expect(host.textContent).toContain('Nothing needs action.')
    expect(host.querySelector('ul[aria-label="Needs action"]')).toBeNull()
    expect(host.querySelector('button[aria-expanded]')?.textContent).toBe('2 more for information')
  })

  it('has no disclosure when there is nothing for information, and says No notes when empty', async () => {
    const only = await mount(panel(notesFor(LIVE.slice(0, 1))))
    expect(only.querySelector('button[aria-expanded]')).toBeNull()
    expect(only.textContent).toContain('12 chunks are missing embeddings')
    const none = await mount(panel(notesFor([])))
    expect(none.textContent).toContain('No notes.')
  })
})

const codexHeight = (host: HTMLElement) => (host.querySelector('[data-syn-id="reader:codex"]') as HTMLElement).style.height

describe('reader blocks', () => {
  const readerBlock = (host: HTMLElement, id: string) => host.querySelector(`[data-syn-id="reader:${id}"]`) as HTMLElement

  function readerSyn() {
    const syn = synoptic()
    syn.readers = [
      { ...syn.readers[0] },
      { ...syn.readers[1], observation: 'not_configured', state: 'inactive', integration: { configured: false, state: 'inactive', observedAt: null, evidence: 'local MCP configuration' } },
      { id: 'claude-code', label: 'Claude Code', state: 'warning', observation: 'observed', observedAt: null },
    ]
    syn.edges = [...syn.edges, { from: 'claude-code', to: 'gbrain', state: 'warning', label: 'configured', observedAt: null }]
    return syn
  }

  it('shows a set-up reader as a compact block with its name only: no dot, no subline, no line label', async () => {
    const syn = readerSyn()
    const host = await mount(createElement(Synoptic, { model: buildBrainModel(syn), selectedId: null, onSelect: () => undefined }))
    const hermes = readerBlock(host, 'hermes')
    expect(hermes.getAttribute('data-presence')).toBe('set_up')
    expect(hermes.hasAttribute('data-state')).toBe(false)
    expect(hermes.querySelector('[data-state]')).toBeNull()
    expect(hermes.textContent).toBe('Hermes')
    expect(hermes.getAttribute('data-compact')).toBe('true')
    expect(host.querySelector('[data-syn-id="reader:codex"]')?.hasAttribute('data-compact')).toBe(false)
    expect(hermes.getAttribute('aria-label')).toBe('Hermes: Set up')
    expect(hermes.style.height).toBe('36px')
    expect(codexHeight(host)).toBe('56px')
    expect(host.querySelector('[data-syn-id="edge:reader:hermes"]')).toBeNull()
    expect(host.textContent).not.toMatch(/configured/i)
  })

  it('shows a reader that is not set up as different and honest, still without a dot', async () => {
    const host = await mount(createElement(Synoptic, { model: buildBrainModel(readerSyn()), selectedId: null, onSelect: () => undefined }))
    const codex = readerBlock(host, 'codex')
    expect(codex.getAttribute('data-presence')).toBe('not_set_up')
    expect(codex.textContent).toBe('CodexNot set up')
    expect(codex.querySelector('[data-state]')).toBeNull()
  })

  it('keeps the state dot and the state word for a reader with a real observed state', async () => {
    const host = await mount(createElement(Synoptic, { model: buildBrainModel(readerSyn()), selectedId: null, onSelect: () => undefined }))
    const observed = readerBlock(host, 'claude-code')
    expect(observed.getAttribute('data-state')).toBe('warning')
    expect(observed.querySelector('[data-state="warning"]')).not.toBeNull()
    expect(observed.textContent).toContain('warning')
    expect(host.querySelector('[data-syn-id="edge:reader:claude-code"]')?.textContent).toBe('warning')
  })

  it('says once under Readers what cannot be read, and drops the old legend entry', async () => {
    const host = await mount(createElement(Synoptic, { model: buildBrainModel(readerSyn()), selectedId: null, onSelect: () => undefined }))
    const text = host.textContent ?? ''
    expect(text.split("Set up to use GBrain. Live connections can't be read from this machine.")).toHaveLength(2)
    expect(host.querySelector('ul[aria-label="Legend"]')?.textContent).not.toMatch(/configured/i)
  })

  it('selecting a reader block opens its detail', async () => {
    const picked: string[] = []
    const host = await mount(createElement(Synoptic, { model: buildBrainModel(readerSyn()), selectedId: null, onSelect: (id: string) => picked.push(id) }))
    await act(async () => readerBlock(host, 'hermes').click())
    expect(picked).toEqual(['reader:hermes'])
  })

  it('draws the narrow list with the caption once, set-up readers by name only and no dot', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 375 })
    class Observer {
      constructor(private cb: () => void) {}
      observe() { this.cb() }
      disconnect() {}
    }
    const previous = globalThis.ResizeObserver
    globalThis.ResizeObserver = Observer as never
    try {
      const host = await mount(createElement(Synoptic, { model: buildBrainModel(readerSyn()), selectedId: null, onSelect: () => undefined }))
      const rows = [...host.querySelectorAll('section[aria-label="Readers"] button')] as HTMLElement[]
      expect(rows.map((row) => row.getAttribute('data-presence'))).toEqual(['set_up', 'not_set_up', null])
      expect(rows[0].querySelector('[data-state]')).toBeNull()
      expect(rows[0].textContent).toBe('Hermes')
    expect(rows[1].textContent).toBe('CodexNot set up')
      expect(rows[2].querySelector('[data-state="warning"]')).not.toBeNull()
      expect(host.textContent).not.toMatch(/configured/i)
      expect((host.textContent ?? '').split("Live connections can't be read from this machine.")).toHaveLength(2)
    } finally {
      globalThis.ResizeObserver = previous
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
    }
  })
})

describe('recovered history in the Notes card', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 10, 11, 0, n)).toISOString()
  const recovered = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const banner: IncidentBanner = {
        title: 'Worst recent regression still needs acknowledgement',
        detail: `1,433 missing embeddings / 3 caveats / queue 14 / 2 / 0 at ${at(i)}.`,
        snapshotId: `s${i}`,
        kind: 'recent-regression',
      }
      return { key: `s${i}`, banner }
    })
  const withRecovered = (count: number, notes = notesFor([]), onAcknowledge = () => undefined) =>
    createElement(NotesPanel, { notes, recovered: recovered(count), onAcknowledge })
  const recoveredToggle = (host: HTMLElement) =>
    [...host.querySelectorAll('button[aria-expanded]')].find((b) => /recovered/.test(b.textContent ?? '')) as HTMLButtonElement

  it('is not something to act on: with only recovered history the top says so and there is no action list', async () => {
    const host = await mount(withRecovered(99))
    expect(host.textContent).toContain('Nothing needs action.')
    expect(host.querySelector('ul[aria-label="Needs action"]')).toBeNull()
    expect(host.textContent).not.toContain('Recovered:')
  })

  it('keeps a real action note in the action list and the history out of it', async () => {
    const host = await mount(withRecovered(3, notesFor(LIVE)))
    const top = host.querySelector('ul[aria-label="Needs action"]')!
    expect(top.querySelectorAll('li')).toHaveLength(1)
    expect(top.textContent).not.toMatch(/recovered|1,433/)
  })

  it('has one summary line, folded by default, with the latest time and the Acknowledge button in the header', async () => {
    const host = await mount(withRecovered(99))
    const toggle = recoveredToggle(host)
    expect(toggle.textContent).toMatch(/^99 past problems recovered on their own · latest /)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)!.hidden).toBe(true)
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Acknowledge all 99')).toBe(true)
    const one = await mount(withRecovered(1))
    expect(recoveredToggle(one).textContent).toMatch(/^1 past problem recovered on its own/)
    expect([...one.querySelectorAll('button')].some((b) => b.textContent === 'Acknowledge')).toBe(true)
  })

  it('shows the ten most recent, newest first, in plain parts, then all of them on request', async () => {
    const onAck: string[] = []
    const host = await mount(withRecovered(99, notesFor([]), () => onAck.push('ack')))
    await act(async () => recoveredToggle(host).click())
    expect(recoveredToggle(host).getAttribute('aria-expanded')).toBe('true')
    const rows = [...host.querySelectorAll('ul[aria-label="Recovered on their own"] li')] as HTMLElement[]
    expect(rows).toHaveLength(10)
    expect(rows[0].textContent).toContain('1,433 missing embeddings · 3 notes · queue: 14 waiting, 2 active, 0 stalled')
    expect(rows[0].textContent).not.toContain(' / ')
    const times = rows.map((row) => row.querySelector('time')!.getAttribute('datetime')!)
    expect(times).toEqual([...times].sort().reverse())
    expect(times[0]).toBe(at(98))
    const more = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show all 99') as HTMLButtonElement
    await act(async () => more.click())
    expect(host.querySelectorAll('ul[aria-label="Recovered on their own"] li')).toHaveLength(99)
    expect([...host.querySelectorAll('button')].some((b) => /^Show all/.test(b.textContent ?? ''))).toBe(false)
  })

  it('never uses a warning or critical state on a recovered row', async () => {
    const host = await mount(withRecovered(12))
    await act(async () => recoveredToggle(host).click())
    const region = document.getElementById(recoveredToggle(host).getAttribute('aria-controls')!)!
    expect(region.querySelector('[data-state]')).toBeNull()
    expect(region.innerHTML).not.toMatch(/warning|critical/i)
  })

  it('uses the same disclosure for recovered history and for information', async () => {
    const host = await mount(withRecovered(2, notesFor(LIVE)))
    const toggles = [...host.querySelectorAll('button[aria-expanded]')] as HTMLButtonElement[]
    expect(toggles.map((t) => t.textContent)).toEqual([
      expect.stringMatching(/^2 past problems recovered on their own/),
      '3 more for information',
    ])
    expect(new Set(toggles.map((t) => t.className)).size).toBe(1)
    for (const toggle of toggles) {
      expect(toggle.getAttribute('aria-controls')).toBeTruthy()
      expect(toggle.querySelector('svg')).not.toBeNull()
    }
  })
})
