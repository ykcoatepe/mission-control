// @vitest-environment jsdom

import { act, createElement, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionConfirmDialog } from './ActionConfirmDialog'
import { DecisionInbox } from './DecisionInbox'
import { EvidenceDrawer } from './EvidenceDrawer'
import { EvidenceTimeline } from './EvidenceTimeline'
import { GBrainTriggerShelf } from './GBrainTriggerShelf'
import { LivingBrainMap } from './LivingBrainMap'
import { SystemStatusRail } from './SystemStatusRail'
import type {
  AttentionItem,
  DrawerSelection,
  EvidenceItem,
  OperationCapability,
  OperationsOverview,
  OperationSystem,
} from './types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ''
})

const systems: OperationSystem[] = [
  {
    id: 'gbrain',
    label: 'GBrain',
    state: 'healthy',
    freshness: 'fresh',
    observedAt: '2026-07-10T12:00:00Z',
    caveats: [],
    metrics: {},
    evidence: [],
    detailHref: '/gbrain',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    state: 'healthy',
    freshness: 'fresh',
    observedAt: '2026-07-10T12:00:00Z',
    caveats: [],
    metrics: {},
    evidence: [],
    detailHref: '/work',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    state: 'warning',
    freshness: 'stale',
    observedAt: null,
    caveats: ['Heartbeat unavailable'],
    metrics: {},
    evidence: [],
    detailHref: '/systems',
  },
]

const overview = {
  systems: Object.fromEntries(systems.map((system) => [system.id, system])),
} as unknown as OperationsOverview

function renderWithRouter(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, element))
}

describe('brain truth components', () => {
  it('renders all three systems without reducing caveats to color only', () => {
    const html = renderWithRouter(createElement(SystemStatusRail, { systems }))

    expect(html).toContain('GBrain')
    expect(html).toContain('Hermes')
    expect(html).toContain('OpenClaw')
    expect(html).toContain('Heartbeat unavailable')
    expect(html).toContain('stale')
    expect(html).toContain('no current proof')
    expect(html).toContain('data-state="warning"')
    expect(html).toContain('data-freshness="stale"')
  })

  it('keeps the fixed three-system map relationship and explicit accessible states', () => {
    const html = renderWithRouter(createElement(LivingBrainMap, {
      overview,
      onSelectSystem: vi.fn(),
    }))

    expect(html.indexOf('GBrain')).toBeLessThan(html.indexOf('Hermes'))
    expect(html.indexOf('Hermes')).toBeLessThan(html.indexOf('OpenClaw'))
    expect(html).toContain('aria-label="OpenClaw: warning, stale, no current proof · Heartbeat unavailable')
    expect(html).toContain('data-freshness="fresh"')
    expect(html).toContain('data-freshness="stale"')
    expect(html).toContain('Sources')
    expect(html).toContain('Triggers')
  })

  it('uses the shared attention policy and leaves an honest empty state', () => {
    const items = [
      { id: 'warning', system: 'hermes', severity: 'warning', title: 'Warning item', detail: 'Needs review' },
      { id: 'critical', system: 'gbrain', severity: 'critical', title: 'Critical item', detail: 'Needs action' },
    ] as AttentionItem[]
    const sortedHtml = renderToStaticMarkup(createElement(DecisionInbox, { items, onSelect: vi.fn() }))
    const emptyHtml = renderToStaticMarkup(createElement(DecisionInbox, { items: [], onSelect: vi.fn() }))

    expect(sortedHtml.indexOf('Critical item')).toBeLessThan(sortedHtml.indexOf('Warning item'))
    expect(sortedHtml).toContain('data-severity="critical"')
    expect(sortedHtml).toContain('data-attention="active"')
    expect(emptyHtml).toContain('Review system freshness')
    expect(emptyHtml).toContain('data-attention="clear"')
  })

  it('limits the evidence stream and labels missing timestamps as unknown', () => {
    const evidence = Array.from({ length: 10 }, (_, index) => ({
      id: `proof-${index}`,
      system: 'gbrain',
      kind: 'health',
      status: 'healthy',
      observedAt: index === 0 ? null : '2026-07-10T12:00:00Z',
      summary: `Proof ${index}`,
      sourceRef: 'gbrain.overview',
      detailHref: '/gbrain',
    })) as EvidenceItem[]
    const html = renderToStaticMarkup(createElement(EvidenceTimeline, { evidence, onSelect: vi.fn() }))

    expect(html).toContain('unknown')
    expect(html).toContain('Proof 7')
    expect(html).not.toContain('Proof 8')
  })

  it('shows R0 directly, W1 as confirm-required, omits W2, and exposes disabled state', () => {
    const actions = [
      {
        id: 'doctor-fast',
        system: 'gbrain',
        label: 'Run fast doctor',
        description: 'Read-only diagnostic',
        safetyClass: 'R0',
        requiresConfirmation: false,
        enabled: true,
      },
      {
        id: 'sync-sources',
        system: 'gbrain',
        label: 'Sync local sources',
        description: 'Refresh source index',
        safetyClass: 'W1',
        requiresConfirmation: true,
        enabled: true,
      },
      {
        id: 'repair-index',
        system: 'gbrain',
        label: 'Repair index',
        description: 'Repair is temporarily unavailable',
        safetyClass: 'W1',
        requiresConfirmation: true,
        enabled: false,
        disabledReason: 'Worker unavailable',
      },
      {
        id: 'danger',
        system: 'gbrain',
        label: 'Delete storage',
        description: 'Destructive action',
        safetyClass: 'W2',
        requiresConfirmation: true,
        enabled: true,
      },
    ] as OperationCapability[]
    const html = renderToStaticMarkup(createElement(GBrainTriggerShelf, {
      actions,
      runningAction: null,
      onRequestRun: vi.fn(),
    }))

    expect(html).toContain('Run fast doctor')
    expect(html).toContain('Read-only diagnostics')
    expect(html).toContain('Runs diagnostic directly')
    expect(html).toContain('Sync local sources')
    expect(html).toContain('Guarded maintenance')
    expect(html).toContain('Confirmation required')
    expect(html).toContain('Worker unavailable')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('Delete storage')
  })

  it('shows the running action and disables every visible trigger while it runs', () => {
    const actions = [
      { id: 'doctor-fast', label: 'Run fast doctor', description: '', safetyClass: 'R0', enabled: true },
      { id: 'sync-sources', label: 'Sync local sources', description: '', safetyClass: 'W1', enabled: true, requiresConfirmation: true },
    ] as OperationCapability[]
    const html = renderToStaticMarkup(createElement(GBrainTriggerShelf, {
      actions,
      runningAction: 'doctor-fast',
      onRequestRun: vi.fn(),
    }))

    expect(html).toContain('Running Run fast doctor')
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })

  it('orders drawer truth as conclusion, evidence, caveats, then detail link', () => {
    const selection = {
      system: 'gbrain',
      title: 'GBrain warning',
      detail: 'Sources are current; embeddings remain delayed.',
      detailHref: '/gbrain',
      caveats: ['Embedding queue delayed'],
      evidence: [{
        id: 'proof-1',
        system: 'gbrain',
        kind: 'health',
        status: 'warning',
        observedAt: null,
        summary: 'Source checkpoint observed',
        sourceRef: 'gbrain.overview',
        detailHref: '/gbrain',
      }],
    } as DrawerSelection
    const html = renderWithRouter(createElement(EvidenceDrawer, { selection, onClose: vi.fn() }))

    expect(html.indexOf('Current conclusion')).toBeLessThan(html.indexOf('Evidence'))
    expect(html.indexOf('Evidence')).toBeLessThan(html.indexOf('Caveats'))
    expect(html.indexOf('Caveats')).toBeLessThan(html.indexOf('Open specialized detail'))
    expect(html).toContain('Observation time unavailable')
    expect(html).toContain('aria-label="Close evidence drawer"')
  })

  it('renders no drawer shell for an empty selection', () => {
    expect(renderToStaticMarkup(createElement(EvidenceDrawer, {
      selection: null,
      onClose: vi.fn(),
    }))).toBe('')
  })

  it('keeps confirmation scoped to one exact W1 action and current proof', () => {
    const action = {
      id: 'sync-sources',
      system: 'gbrain',
      label: 'Sync local sources',
      description: 'Refresh source index',
      safetyClass: 'W1',
      timeoutMs: 90_000,
    } as OperationCapability
    const html = renderToStaticMarkup(createElement(ActionConfirmDialog, {
      action,
      proof: systems[0],
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      returnFocusRef: createRef<HTMLButtonElement>(),
    }))

    expect(html).toContain('W1 · GBrain')
    expect(html).toContain('healthy · fresh')
    expect(html).toContain('2 minutes')
    expect(html).toContain('Run Sync local sources')
    expect(html).not.toContain('Approve all')
  })

  it('refuses to render a W2 confirmation dialog', () => {
    const html = renderToStaticMarkup(createElement(ActionConfirmDialog, {
      action: {
        id: 'danger',
        system: 'gbrain',
        label: 'Delete storage',
        description: 'Destructive action',
        safetyClass: 'W2',
      } as OperationCapability,
      proof: systems[0],
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
      returnFocusRef: createRef<HTMLButtonElement>(),
    }))

    expect(html).toBe('')
  })

  it('cancels only when the confirmation backdrop itself is pressed', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const onCancel = vi.fn()
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(ActionConfirmDialog, {
        action: {
          id: 'sync-sources',
          system: 'gbrain',
          label: 'Sync local sources',
          description: 'Refresh source index',
          safetyClass: 'W1',
        } as OperationCapability,
        proof: systems[0],
        onCancel,
        onConfirm: vi.fn(),
        returnFocusRef: createRef<HTMLButtonElement>(),
      }))
    })

    const dialog = host.querySelector('[role="dialog"]') as HTMLElement
    const backdrop = dialog.parentElement as HTMLElement
    await act(async () => {
      dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onCancel).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
  })

  it('moves focus into confirmation, cancels with Escape, and restores trigger focus', async () => {
    const host = document.createElement('div')
    const trigger = document.createElement('button')
    trigger.textContent = 'Trigger'
    document.body.append(trigger, host)
    trigger.focus()
    const returnFocusRef = { current: trigger }
    const onCancel = vi.fn()
    const root = createRoot(host)

    await act(async () => {
      root.render(createElement(ActionConfirmDialog, {
        action: {
          id: 'sync-sources',
          system: 'gbrain',
          label: 'Sync local sources',
          description: 'Refresh source index',
          safetyClass: 'W1',
          timeoutMs: 60_000,
        } as OperationCapability,
        proof: systems[0],
        onCancel,
        onConfirm: vi.fn(),
        returnFocusRef,
      }))
    })

    expect(document.activeElement?.textContent).toBe('Run Sync local sources')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      root.unmount()
    })
    expect(onCancel).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(trigger)
  })
})
