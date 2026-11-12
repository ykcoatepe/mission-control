// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UI_STATES } from '../../lib/state'
import type { UiState } from '../../lib/state'
import { AlarmLine } from './AlarmLine'
import { AnalogBar } from './AnalogBar'
import { Block } from './Block'
import { Freshness } from './Freshness'
import { Meter } from './Meter'
import { NavBadge } from './NavBadge'
import { Notice } from './Notice'
import { Panel } from './Panel'
import { StateDot } from './StateDot'
import { StateMark } from './StateMark'
import { StatePill } from './StatePill'
import { Trend } from './Trend'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

async function render(node: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  return { host, root }
}

afterEach(() => {
  document.body.innerHTML = ''
})

const SHAPE_ELEMENT: Record<UiState, string> = {
  healthy: 'circle',
  warning: 'polygon',
  critical: 'rect',
  unavailable: 'circle',
  inactive: 'rect',
}

describe('StateMark: state is never colour alone', () => {
  it('draws each state with its own shape', async () => {
    const { host, root } = await render(
      createElement('div', null, ...UI_STATES.map((state) => createElement(StateMark, { key: state, state }))),
    )
    const marks = [...host.querySelectorAll('svg')]
    expect(marks.map((m) => m.getAttribute('data-shape'))).toEqual(['circle', 'triangle', 'square', 'ring', 'dash'])
    UI_STATES.forEach((state, i) => {
      expect(marks[i].querySelector(SHAPE_ELEMENT[state])).not.toBeNull()
    })
    // Normal is a filled circle; not read is the same circle hollow.
    expect(marks[0].querySelector('circle')?.getAttribute('fill')).toBe('currentColor')
    expect(marks[3].querySelector('circle')?.getAttribute('fill')).toBe('none')
    await act(async () => root.unmount())
  })

  it('is hidden from assistive tech beside a word, and named when it stands alone', async () => {
    const { host, root } = await render(
      createElement('div', null, createElement(StateMark, { state: 'warning' }), createElement(StateMark, { state: 'critical', label: 'GBrain' })),
    )
    const [beside, alone] = [...host.querySelectorAll('svg')]
    expect(beside.getAttribute('aria-hidden')).toBe('true')
    expect(beside.hasAttribute('role')).toBe(false)
    expect(alone.getAttribute('role')).toBe('img')
    expect(alone.getAttribute('aria-label')).toBe('GBrain: Critical')
    await act(async () => root.unmount())
  })

  it('StateDot is the same mark', async () => {
    const { host, root } = await render(createElement(StateDot, { state: 'critical', label: 'Disk' }))
    expect(host.querySelector('svg')?.getAttribute('data-shape')).toBe('square')
    expect(host.querySelector('svg')?.getAttribute('aria-label')).toBe('Disk: Critical')
    await act(async () => root.unmount())
  })

  it('StatePill pairs the mark with a word; normal reads "Normal", never "Healthy"', async () => {
    const { host, root } = await render(
      createElement('div', null, ...UI_STATES.map((state) => createElement(StatePill, { key: state, state }))),
    )
    const pills = [...host.querySelectorAll('span[data-state]')]
    expect(pills.map((p) => p.textContent)).toEqual(['Normal', 'Caution', 'Critical', 'Not read', 'Off'])
    expect(pills.map((p) => p.querySelector('svg')?.getAttribute('data-shape'))).toEqual(['circle', 'triangle', 'square', 'ring', 'dash'])
    await act(async () => root.unmount())
  })
})

describe('AlarmLine', () => {
  it('is an alert for critical and a status for caution, with the state word and the sentence', async () => {
    const { host, root } = await render(
      createElement('div', null,
        createElement(AlarmLine, { state: 'critical', title: 'Hermes is down' }),
        createElement(AlarmLine, { state: 'warning', title: 'Missing embeddings: 9 chunks', detail: 'Since the last sync' }),
      ),
    )
    const [critical, caution] = [...(host.firstElementChild as HTMLElement).children] as HTMLElement[]
    expect(critical.getAttribute('role')).toBe('alert')
    expect(critical.textContent).toContain('Critical')
    expect(critical.querySelector('svg')?.getAttribute('data-shape')).toBe('square')
    expect(caution.getAttribute('role')).toBe('status')
    expect(caution.textContent).toContain('Caution')
    expect(caution.textContent).toContain('Missing embeddings: 9 chunks')
    expect(caution.querySelector('svg')?.getAttribute('data-shape')).toBe('triangle')
    await act(async () => root.unmount())
  })

  it('carries at most one action, and it runs', async () => {
    const onClick = vi.fn()
    const { host, root } = await render(createElement(AlarmLine, { state: 'warning', title: 'x', action: { label: 'Backfill embeddings', onClick } }))
    const buttons = host.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    await act(async () => buttons[0].click())
    expect(onClick).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it('a busy action is disabled and says it is busy', async () => {
    const onClick = vi.fn()
    const { host, root } = await render(createElement(AlarmLine, { state: 'warning', title: 'x', action: { label: 'Backfill', onClick, busy: true } }))
    const button = host.querySelector('button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    await act(async () => root.unmount())
  })

  it('has no button when there is no action, and shows only a real "since" time', async () => {
    const { host, root } = await render(
      createElement('div', null,
        createElement(AlarmLine, { state: 'warning', title: 'a' }),
        createElement(AlarmLine, { state: 'warning', title: 'b', since: new Date().toISOString() }),
        createElement(AlarmLine, { state: 'warning', title: 'c', since: 'not a time' }),
      ),
    )
    expect(host.querySelectorAll('button')).toHaveLength(0)
    const lines = [...(host.firstElementChild as HTMLElement).children]
    expect(lines[0].textContent).not.toContain('since')
    expect(lines[1].textContent).toMatch(/since \d{2}:\d{2}/)
    expect(lines[2].textContent).not.toContain('since')
    await act(async () => root.unmount())
  })
})

const HISTORY = [0, 1, 2, 3].map((i) => ({ t: 1_000 * i, v: 99 + i / 10 }))

describe('AnalogBar', () => {
  it('is a meter with the reading, the range and a text alternative', async () => {
    const { host, root } = await render(createElement(AnalogBar, { label: 'Quality', value: 99, min: 0, max: 100, band: [95, 100] }))
    const meter = host.querySelector('[role="meter"]') as HTMLElement
    expect(meter.getAttribute('aria-label')).toBe('Quality')
    expect(meter.getAttribute('aria-valuenow')).toBe('99')
    expect(meter.getAttribute('aria-valuemin')).toBe('0')
    expect(meter.getAttribute('aria-valuemax')).toBe('100')
    expect(meter.getAttribute('aria-valuetext')).toBe('99, normal 95 – 100')
    expect(host.textContent).toContain('Normal: 95 – 100')
    await act(async () => root.unmount())
  })

  it('in band it is neutral: no mark, no state word', async () => {
    const { host, root } = await render(createElement(AnalogBar, { label: 'Quality', value: 99, min: 0, max: 100, band: [95, 100] }))
    expect((host.firstElementChild as HTMLElement).getAttribute('data-state')).toBe('healthy')
    expect(host.querySelector('svg')).toBeNull()
    expect(host.textContent).not.toMatch(/below|above|not read/i)
    await act(async () => root.unmount())
  })

  it('out of band it says so in words with a caution mark', async () => {
    const { host, root } = await render(
      createElement('div', null,
        createElement(AnalogBar, { label: 'Embedded', value: 90, min: 0, max: 100, band: [95, 100], unit: '%' }),
        createElement(AnalogBar, { label: 'Queue', value: 7, min: 0, max: 4, band: [0, 2] }),
      ),
    )
    const [low, high] = [...(host.firstElementChild as HTMLElement).children] as HTMLElement[]
    expect(low.getAttribute('data-state')).toBe('warning')
    expect(low.textContent).toContain('below normal')
    expect(low.querySelector('svg')?.getAttribute('data-shape')).toBe('triangle')
    expect(low.querySelector('[role="meter"]')?.getAttribute('aria-valuetext')).toBe('90%, normal 95% – 100%, below normal')
    expect(high.textContent).toContain('above normal')
    // The pointer stays on the scale; the meter value is clamped to the range.
    expect(high.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('4')
    await act(async () => root.unmount())
  })

  it('an explicit state wins over the band and uses the state word', async () => {
    const { host, root } = await render(createElement(AnalogBar, { label: 'Budget', value: 96, min: 0, max: 100, state: 'critical' }))
    expect((host.firstElementChild as HTMLElement).getAttribute('data-state')).toBe('critical')
    expect(host.textContent).toContain('critical')
    expect(host.querySelector('svg')?.getAttribute('data-shape')).toBe('square')
    await act(async () => root.unmount())
  })

  it('unread shows a hollow circle and "not read": no value, no pointer, no trend', async () => {
    const { host, root } = await render(
      createElement(AnalogBar, { label: 'Quality', value: 99, min: 0, max: 100, band: [95, 100], unread: true, trend: HISTORY }),
    )
    const meter = host.querySelector('[role="meter"]') as HTMLElement
    expect(meter.hasAttribute('aria-valuenow')).toBe(false)
    expect(meter.getAttribute('aria-valuetext')).toBe('Not read')
    expect(host.textContent).toContain('not read')
    expect(host.textContent).not.toContain('99')
    expect(host.querySelector('svg')?.getAttribute('data-shape')).toBe('ring')
    expect(host.querySelector('[role="img"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('a missing value is not read, never 0', async () => {
    const { host, root } = await render(createElement(AnalogBar, { label: 'Quality', value: null, min: 0, max: 100 }))
    expect(host.querySelector('[role="meter"]')?.hasAttribute('aria-valuenow')).toBe(false)
    expect(host.textContent).toContain('not read')
    await act(async () => root.unmount())
  })

  it('draws a trend only from real history, with its average', async () => {
    const { host, root } = await render(
      createElement('div', null,
        createElement(AnalogBar, { label: 'With', value: 99, min: 0, max: 100, band: [95, 100], trend: HISTORY, format: (n) => n.toFixed(2) }),
        createElement(AnalogBar, { label: 'One point', value: 99, min: 0, max: 100, trend: [{ t: 1, v: 99 }] }),
        createElement(AnalogBar, { label: 'None', value: 99, min: 0, max: 100 }),
      ),
    )
    const [withTrend, onePoint, none] = [...(host.firstElementChild as HTMLElement).children] as HTMLElement[]
    expect(withTrend.querySelector('svg[aria-label="24-hour trend"]')).not.toBeNull()
    expect(withTrend.textContent).toContain('99.15 avg')
    expect(withTrend.textContent).toContain('24h trend')
    expect(onePoint.querySelector('svg')).toBeNull()
    expect(onePoint.textContent).not.toContain('trend')
    expect(none.querySelector('svg')).toBeNull()
    await act(async () => root.unmount())
  })

  it('labels the limits on the scale and leaves out one that would sit on another', async () => {
    const { host, root } = await render(createElement(AnalogBar, { label: 'Quality', value: 99, min: 0, max: 100, band: [95, 100] }))
    const labels = [...host.querySelectorAll('[aria-hidden="true"] > span')].map((n) => n.textContent)
    // 95 is within 12% of 100, so the caption "Normal: 95 – 100" says it instead of a crowded label.
    expect(labels).toEqual(['0', '100'])
    await act(async () => root.unmount())
    const wide = await render(createElement(AnalogBar, { label: 'Queue', value: 2, min: 0, max: 10, band: [0, 4] }))
    const spread = [...wide.host.querySelectorAll('[aria-hidden="true"] > span')].map((n) => n.textContent)
    expect(spread).toEqual(['0', '4', '10'])
    await act(async () => wide.root.unmount())
  })

  it('Meter with a band is an AnalogBar; without one it is the thin bar', async () => {
    const { host, root } = await render(
      createElement('div', null,
        createElement(Meter, { label: 'Budget', value: 40 }),
        createElement(Meter, { label: 'Quality', value: 99, band: [95, 100] }),
        createElement(Meter, { label: 'Unread', value: null }),
      ),
    )
    const meters = [...host.querySelectorAll('[role="meter"]')]
    expect(meters).toHaveLength(3)
    expect(meters[0].getAttribute('aria-valuenow')).toBe('40')
    expect(meters[1].getAttribute('aria-valuetext')).toBe('99, normal 95 – 100')
    expect(meters[2].hasAttribute('aria-valuenow')).toBe(false)
    expect(meters[2].getAttribute('aria-valuetext')).toBe('Not read')
    await act(async () => root.unmount())
  })
})

describe('Trend', () => {
  it('draws nothing for fewer than two readings, and ignores unusable ones', async () => {
    const { host, root } = await render(
      createElement('div', null,
        createElement(Trend, { points: [] }),
        createElement(Trend, { points: [{ t: 1, v: 1 }] }),
        createElement(Trend, { points: [{ t: 1, v: Number.NaN }, { t: 2, v: 2 }] }),
        createElement(Trend, { points: null }),
        createElement(Trend, { points: HISTORY }),
      ),
    )
    expect(host.querySelectorAll('svg')).toHaveLength(1)
    expect(host.querySelector('path')?.getAttribute('d')).toMatch(/^M0\.00 /)
    await act(async () => root.unmount())
  })

  it('draws the normal band behind the line only when given one', async () => {
    const { host, root } = await render(
      createElement('div', null, createElement(Trend, { points: HISTORY }), createElement(Trend, { points: HISTORY, band: [95, 100] })),
    )
    const [plain, banded] = [...host.querySelectorAll('svg')]
    expect(plain.querySelector('rect')).toBeNull()
    expect(banded.querySelector('rect')).not.toBeNull()
    await act(async () => root.unmount())
  })
})

describe('NavBadge (badge rule)', () => {
  it('renders nothing at 0, for a missing count, and for a count that is not a number', async () => {
    const { host, root } = await render(
      createElement('div', null,
        createElement(NavBadge, { count: 0, state: 'warning' }),
        createElement(NavBadge, { count: null, state: 'warning' }),
        createElement(NavBadge, { count: undefined, state: 'warning' }),
        createElement(NavBadge, { count: Number.NaN, state: 'warning' }),
        createElement(NavBadge, { count: -2, state: 'warning' }),
      ),
    )
    expect(host.innerHTML).toBe('<div></div>')
    await act(async () => root.unmount())
  })

  it('shows the count with its shape and a spoken word', async () => {
    const { host, root } = await render(
      createElement('div', null,
        createElement(NavBadge, { count: 3, state: 'warning', word: 'need attention' }),
        createElement(NavBadge, { count: 1500, state: 'critical', word: 'failed' }),
      ),
    )
    const [a, b] = [...host.querySelectorAll('[data-testid="nav-badge"]')]
    expect(a.textContent).toContain('3')
    expect(a.textContent).toContain('3 need attention')
    expect(a.querySelector('svg')?.getAttribute('data-shape')).toBe('triangle')
    expect(b.querySelector('svg')?.getAttribute('data-shape')).toBe('square')
    expect(b.textContent).toContain('999+')
    expect(b.textContent).toContain('1500 failed')
    await act(async () => root.unmount())
  })
})

describe('Block and Panel', () => {
  it('a block has a header with the title and the count at the right', async () => {
    const { host, root } = await render(
      createElement(Block, { title: 'Projects (9)', meta: '7,710 pages', tone: 'projects' }, createElement('p', null, 'body')),
    )
    const section = host.querySelector('section') as HTMLElement
    expect(section.getAttribute('data-tone')).toBe('projects')
    expect(host.querySelector('h2')?.textContent).toBe('Projects (9)')
    expect(host.querySelector('header')?.textContent).toContain('7,710 pages')
    expect(host.textContent).toContain('body')
    await act(async () => root.unmount())
  })

  it('has no header when it has nothing to say there', async () => {
    const { host, root } = await render(createElement(Block, null, createElement('p', null, 'only body')))
    expect(host.querySelector('header')).toBeNull()
    await act(async () => root.unmount())
  })

  it('Panel keeps its API: title, description, actions, heading level, label', async () => {
    const { host, root } = await render(
      createElement(Panel, { title: 'Budget', description: 'This month', actions: createElement('button', { type: 'button' }, 'Edit'), titleAs: 'h3', 'aria-label': 'Budget panel' }, 'content'),
    )
    expect(host.querySelector('h3')?.textContent).toBe('Budget')
    expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('Budget panel')
    expect(host.textContent).toContain('This month')
    expect(host.querySelector('header button')?.textContent).toBe('Edit')
    await act(async () => root.unmount())
  })
})

describe('Freshness (rule 8: annotate only stale or unread)', () => {
  it('a fresh reading is not annotated', async () => {
    const { host, root } = await render(createElement(Freshness, { observedAt: new Date().toISOString() }))
    expect(host.innerHTML).toBe('')
    await act(async () => root.unmount())
  })

  it('a stale reading says "as of" its real time with a caution mark', async () => {
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString()
    const { host, root } = await render(createElement(Freshness, { observedAt: old }))
    expect(host.textContent).toMatch(/^as of /)
    expect(host.querySelector('svg')?.getAttribute('data-shape')).toBe('triangle')
    await act(async () => root.unmount())
  })

  it('an unread reading is a hollow circle and "not read"', async () => {
    const { host, root } = await render(createElement('div', null, createElement(Freshness, { observedAt: null }), createElement(Freshness, { observedAt: 'x', state: 'unknown' })))
    expect(host.textContent).toBe('not readnot read')
    expect([...host.querySelectorAll('svg')].map((s) => s.getAttribute('data-shape'))).toEqual(['ring', 'ring'])
    await act(async () => root.unmount())
  })
})

describe('Notice', () => {
  it('shows a shape only for caution and critical; healthy is plain', async () => {
    const { host, root } = await render(
      createElement('div', null,
        createElement(Notice, { tone: 'healthy', title: 'All good' }),
        createElement(Notice, { tone: 'warning', title: 'Careful' }),
        createElement(Notice, { tone: 'critical', title: 'Broken' }),
      ),
    )
    const [ok, caution, critical] = [...host.querySelectorAll('[data-tone]')]
    expect(ok.querySelector('svg')).toBeNull()
    expect(caution.querySelector('svg')?.getAttribute('data-shape')).toBe('triangle')
    expect(critical.querySelector('svg')?.getAttribute('data-shape')).toBe('square')
    expect(critical.getAttribute('role')).toBe('alert')
    await act(async () => root.unmount())
  })
})
