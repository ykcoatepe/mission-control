// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CostPulseHeader from './CostPulseHeader'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../components/GlassCard', () => ({
  default: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}))

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  readonly observed: Element[] = []
  readonly disconnect = vi.fn()
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    MockResizeObserver.instances.push(this)
  }

  observe = vi.fn((element: Element) => {
    this.observed.push(element)
  })

  unobserve = vi.fn()

  trigger() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

const baseProps = {
  m: true,
  period: 'month' as const,
  setPeriod: vi.fn(),
  monthAnchor: null,
  setMonthAnchor: vi.fn(),
  calendarNow: new Date('2026-08-01T12:00:00Z'),
  serverMonth: '2026-08',
  monthAvailability: [],
  monthAvailabilityKnown: false,
  dayUsage: [],
  activeChartDate: null,
  onSelectDay: vi.fn(),
  viewingPastMonth: false,
  anchoredMonthLabel: null,
  activePeriodLabel: 'August 2026',
  hasAwsData: false,
  ledgerActive: false,
  costSourceLabel: 'Local',
  overviewPills: [],
  codexbarActive: false,
  codexbarCosts: null,
  codexbarPeriodTokens: 0,
  currentPeriodCost: 0,
  dailyAvg: 0,
  projectedMonthly: 0,
  apiEquivalentPeriodCost: null,
  apiEquivalentDailyAvg: null,
  apiEquivalentProjectedMonthly: null,
  apiEquivalentReliability: 'unavailable',
  trackedSpend: {
    isPartial: false,
    valueQualifier: null,
    coverageLabel: null,
    projectionAvailable: true,
  },
  trackedValueAvailable: true,
}

afterEach(() => {
  document.body.innerHTML = ''
  MockResizeObserver.instances = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CostPulseHeader column overlap guard', () => {
  it('stacks by the header container width, not only the viewport', () => {
    // The sidebar eats a fixed slice of any viewport, so a viewport-only media
    // query leaves a band of window widths where the two columns overlap and
    // the right column swallows the month-nav clicks. The primary rule must be
    // a container query on the card shell.
    const css = readFileSync(join(__dirname, 'CostPulseHeader.module.css'), 'utf8')
    expect(css).toContain('container-type: inline-size')
    expect(css).toMatch(/@container \(max-width: \d+px\) \{\s*\.outer \{\s*grid-template-columns: 1fr;/)
  })
})

describe('CostPulseHeader month picker viewport clamp', () => {
  it('re-clamps on layout changes and availability commits, then cleans up observers and RAF work', async () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(375)
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      frames.delete(id)
    })
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const flushFrame = async () => {
      const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined
      expect(entry).toBeDefined()
      frames.delete(entry![0])
      await act(async () => entry![1](0))
    }

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(CostPulseHeader, baseProps)))
    const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')
    await act(async () => trigger?.click())

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    const rect = vi.spyOn(dialog!, 'getBoundingClientRect')
    rect.mockReturnValue({ left: -6, right: 286 } as DOMRect)
    const firstObserver = MockResizeObserver.instances[0]
    expect(firstObserver.observed).toEqual([document.body, dialog])
    await flushFrame()
    expect(dialog!.style.transform).toBe('translateX(14px)')

    rect.mockReturnValue({ left: 154, right: 446 } as DOMRect)
    firstObserver.trigger()
    await flushFrame()
    expect(dialog!.style.transform).toBe('translateX(-79px)')

    await act(async () => root.render(createElement(CostPulseHeader, {
      ...baseProps,
      monthAvailability: [{ month: '2026-07', hasData: true, sources: ['openclaw'] }],
      monthAvailabilityKnown: true,
    })))
    expect(firstObserver.disconnect).toHaveBeenCalledOnce()
    expect(MockResizeObserver.instances).toHaveLength(2)

    rect.mockReturnValue({ left: 20, right: 312 } as DOMRect)
    await flushFrame()
    expect(dialog!.style.transform).toBe('')

    MockResizeObserver.instances[1].trigger()
    expect(requestFrame).toHaveBeenCalled()
    await act(async () => root.unmount())
    expect(MockResizeObserver.instances[1].disconnect).toHaveBeenCalledOnce()
    expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(cancelFrame).toHaveBeenCalled()
  })
})
