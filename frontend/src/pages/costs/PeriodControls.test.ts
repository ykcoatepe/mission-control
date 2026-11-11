// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PeriodControls from './PeriodControls'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
}

afterEach(() => {
  document.body.innerHTML = ''
  MockResizeObserver.instances = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PeriodControls picker styles', () => {
  it('keeps the picker inside narrow viewports and centred on its trigger', () => {
    const css = readFileSync(join(__dirname, 'PeriodControls.module.css'), 'utf8')
    expect(css).toContain('max-width: min(292px, calc(100vw - 32px))')
    expect(css).toContain('translate: -50% 0;')
    expect(css).toContain('grid-template-columns: repeat(3, minmax(0, 1fr));')
  })

  it('uses no colour literals', () => {
    const css = readFileSync(join(__dirname, 'PeriodControls.module.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })
})

describe('PeriodControls month picker viewport clamp', () => {
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
    await act(async () => root.render(createElement(PeriodControls, baseProps)))
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

    await act(async () => root.render(createElement(PeriodControls, {
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

async function mountControls(props: Partial<typeof baseProps> & Record<string, unknown> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = (next: Record<string, unknown> = {}) => act(async () => root.render(createElement(PeriodControls, { ...baseProps, ...props, ...next } as never)))
  await render()
  const trigger = () => host.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!
  const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')
  return { host, root, render, trigger, dialog }
}

describe('PeriodControls month picker behaviour', () => {
  it('opens an accessible dialog from the month label and returns focus to it when it closes', async () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    const { trigger, dialog } = await mountControls()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    await act(async () => trigger().click())
    expect(dialog()).not.toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(dialog()!.contains(document.activeElement)).toBe(true)

    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(trigger())

    // Picking a day also closes the dialog and hands focus back.
    const onSelectDay = vi.fn()
    document.body.innerHTML = ''
    const second = await mountControls({ onSelectDay, dayUsage: [{ date: '2026-08-01', cost: 5, tokens: 100 }] })
    await act(async () => second.trigger().click())
    const day = second.host.querySelector<HTMLButtonElement>('button[aria-label="Show 2026-08-01 usage"]')
    await act(async () => day?.click())
    expect(onSelectDay).toHaveBeenCalledWith('2026-08-01')
    expect(second.dialog()).toBeNull()
    expect(document.activeElement).toBe(second.trigger())
  })

  it('moves focus into the dialog only when it opens, never on a data re-render', async () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    const { trigger, dialog, render } = await mountControls()
    await act(async () => trigger().click())
    expect(dialog()!.contains(document.activeElement)).toBe(true)

    // The user moves on to a header control; late-arriving usage data must not pull focus back.
    trigger().focus()
    await render({ dayUsage: [{ date: '2026-08-02', cost: 9, tokens: 10 }], activeChartDate: '2026-08-02' })
    expect(document.activeElement).toBe(trigger())
  })

  it('closes and cleans up its document listeners when the period leaves Monthly', async () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    const removeListener = vi.spyOn(document, 'removeEventListener')
    const setPeriod = vi.fn()
    const { host, trigger, dialog, render } = await mountControls({ setPeriod })
    await act(async () => trigger().click())
    expect(dialog()).not.toBeNull()

    const sevenDays = Array.from(host.querySelectorAll<HTMLElement>('[role="radio"]')).find(el => el.textContent === '7 days')
    await act(async () => sevenDays?.click())
    expect(setPeriod).toHaveBeenCalledWith('7d')
    await render({ period: '7d' })
    expect(dialog()).toBeNull()
    expect(removeListener).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    expect(removeListener).toHaveBeenCalledWith('keydown', expect.any(Function))

    // Coming back to Monthly starts with the picker closed.
    await render({ period: 'month' })
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('anchors a chosen month, but sends the live month back as "no anchor"', async () => {
    const setMonthAnchor = vi.fn()
    const { host, render } = await mountControls({ setMonthAnchor })
    const step = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
    await act(async () => step('Show July 2026').click())
    expect(setMonthAnchor).toHaveBeenLastCalledWith('2026-07')

    await render({ monthAnchor: '2026-07' })
    await act(async () => step('Show August 2026').click())
    expect(setMonthAnchor).toHaveBeenLastCalledWith(null)
  })

  it('stops the arrows at the current month going forward and at the history floor going back', async () => {
    const live = await mountControls()
    expect(live.host.querySelector<HTMLButtonElement>('button[aria-label="Show September 2026"]')!.disabled).toBe(true)
    document.body.innerHTML = ''
    const floor = await mountControls({ monthAnchor: '2024-08' })
    expect(floor.host.querySelector<HTMLButtonElement>('button[aria-label="Show July 2024"]')!.disabled).toBe(true)
  })

  it('greys out months the availability scan confirmed empty, but keeps unscanned ones selectable', async () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    const { host, trigger } = await mountControls({
      monthAvailabilityKnown: true,
      monthAvailability: [
        { month: '2026-06', hasData: false, sources: [] },
        { month: '2026-07', hasData: true, sources: ['codexbar'] },
        { month: '2026-05', hasData: false, sources: [], unknown: true },
      ],
    })
    await act(async () => trigger().click())
    const title = host.querySelector<HTMLButtonElement>('button[aria-label^="Choose a different month"]')
    await act(async () => title?.click())
    const cell = (month: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Show ${month}"]`)!
    expect(cell('2026-06').getAttribute('aria-disabled')).toBe('true')
    expect(cell('2026-07').getAttribute('aria-disabled')).toBe('false')
    expect(cell('2026-05').getAttribute('aria-disabled')).toBe('false')
    // The live month stays reachable even though availability has no entry for it.
    expect(cell('2026-08').getAttribute('aria-disabled')).toBe('false')
  })
})
