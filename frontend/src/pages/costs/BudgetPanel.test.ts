// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BudgetPanel from './BudgetPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const base = {
  budget: null as number | null,
  budgetInput: '',
  setBudgetInput: vi.fn(),
  noBudget: true,
  setNoBudget: vi.fn(),
  saveBudget: vi.fn(),
  savingBudget: false,
  canSaveBudget: true,
  budgetError: null as string | null,
  budgetUsage: null,
  budgetUsagePct: null,
  budgetRemaining: null,
  monthlyBudgetBase: null,
  spendLabel: 'Tracked spend this month',
}

async function render(props: Partial<typeof base> = {}) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(BudgetPanel, { ...base, ...props })))
  return { host, root }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('BudgetPanel', () => {
  it('offers "No monthly budget" explicitly and disables the amount while it is on', async () => {
    const { host, root } = await render()
    const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('No monthly budget')
    // The fact "no monthly budget" is said once, by the switch.
    expect(host.textContent).not.toContain('No monthly cap set.')
    expect(host.textContent?.match(/no (monthly )?(budget|cap)/gi)).toHaveLength(1)
    expect(toggle.getAttribute('aria-label')).toBe('No monthly budget')
    const input = host.querySelector('input[type="number"]') as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(input.value).toBe('')
    await act(async () => toggle.click())
    expect(base.setNoBudget).toHaveBeenCalledWith(false)
    await act(async () => root.unmount())
  })

  it('with a cap, the amount is editable and zero is not shown as a saved cap', async () => {
    const { host, root } = await render({ budget: 150, budgetInput: '150', noBudget: false })
    const input = host.querySelector('input[type="number"]') as HTMLInputElement
    expect(input.disabled).toBe(false)
    expect(input.value).toBe('150')
    expect(host.textContent).not.toContain('No monthly cap set.')
    expect(host.textContent).not.toContain('No cap is saved yet.')
    await act(async () => root.unmount())
  })

  it('submits through saveBudget and shows a server message next to the amount', async () => {
    const { host, root } = await render({ budgetError: 'monthly budget must be a finite number, zero or positive, or null', noBudget: false, budgetInput: '5' })
    expect(host.textContent).toContain('monthly budget must be a finite number')
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(base.saveBudget).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
  })
})
