// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'
import { IconButton } from './IconButton'
import { Switch } from './Switch'
import { accessibleName, unnamedControls } from './a11y.testkit'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

async function render(node: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  return { host, root }
}

describe('button names', () => {
  it('writes the name of a text button, so a clipped or hidden label cannot leave it empty', async () => {
    const { host, root } = await render(
      createElement('div', null,
        createElement(Button, null, 'Cancel'),
        createElement(Button, { type: 'submit', variant: 'primary', loading: true }, 'Save'),
        createElement(Button, { icon: createElement('svg') }, 'New entry'),
        createElement(Button, null, 'Run ', createElement('b', null, 'sync')),
        createElement(Button, { 'aria-label': 'Run Backup now' }, 'Run now'),
      ),
    )
    const names = [...host.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['Cancel', 'Save', 'New entry', 'Run sync', 'Run Backup now'])
    expect(unnamedControls(host)).toEqual([])
    await act(async () => root.unmount())
  })

  it('names a switch from its visible label when no aria-label is given', async () => {
    const { host, root } = await render(createElement(Switch, { checked: false, onChange: () => undefined, label: 'Hide disabled' }))
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Hide disabled')
    await act(async () => root.unmount())
  })

  it('the helper finds an icon-only button with no name and accepts a named one', async () => {
    const { host, root } = await render(
      createElement('div', null,
        createElement('button', { type: 'button' }, createElement('svg', { 'aria-hidden': 'true' })),
        createElement(IconButton, { label: 'Next week', icon: createElement('svg') }),
      ),
    )
    expect(unnamedControls(host)).toHaveLength(1)
    expect(accessibleName(host.querySelectorAll('button')[1])).toBe('Next week')
    await act(async () => root.unmount())
  })
})
