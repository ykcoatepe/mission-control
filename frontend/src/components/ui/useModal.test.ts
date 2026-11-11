// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog } from './Dialog'
import { Drawer } from './Drawer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ''
})

describe('stacked modals', () => {
  it('closes only the dialog when Esc is pressed over a drawer, and returns focus to the opener', async () => {
    const onCloseDrawer = vi.fn()
    const onCloseDialog = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const opener = document.createElement('button')
    opener.textContent = 'Delete'
    document.body.append(opener)
    opener.focus()

    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement(Drawer, { open: true, onClose: onCloseDrawer, title: 'Job', children: createElement('p', null, 'detail') }),
          createElement(Dialog, { open: true, onClose: onCloseDialog, title: 'Delete job?', actions: createElement('button', { type: 'button' }, 'Cancel') }),
        ),
      ),
    )
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCloseDialog).toHaveBeenCalledTimes(1)
    expect(onCloseDrawer).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })

  it('lets the drawer handle Esc again once the dialog is gone', async () => {
    const onCloseDrawer = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const render = (dialogOpen: boolean) =>
      root.render(
        createElement(
          'div',
          null,
          createElement(Drawer, { open: true, onClose: onCloseDrawer, title: 'Job', children: createElement('p', null, 'detail') }),
          createElement(Dialog, { open: dialogOpen, onClose: () => undefined, title: 'Delete job?' }),
        ),
      )
    await act(async () => render(true))
    await act(async () => render(false))
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onCloseDrawer).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })
})
