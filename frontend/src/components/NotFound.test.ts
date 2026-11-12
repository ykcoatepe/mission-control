// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import AppRouteTable from './AppRouteTable'
import { PageTitleProvider } from './ui'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ''
})

describe('an unknown route', () => {
  it('says Page not found and links to Brain, instead of a blank page', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(createElement(MemoryRouter, { initialEntries: ['/no/such/page'] }, createElement(PageTitleProvider, null, createElement(AppRouteTable)))),
    )
    expect(host.textContent).toContain('Page not found')
    const link = host.querySelector('a') as HTMLAnchorElement
    expect(link.textContent).toBe('Back to Brain')
    expect(link.getAttribute('href')).toBe('/')
    await act(async () => root.unmount())
  })
})
