import { describe, expect, it } from 'vitest'
import {
  appRoutes,
  isRouteEnabled,
  primarySidebarRoutes,
  utilitySidebarRoutes,
} from './appRoutes'

const byPath = (path: string) => appRoutes.find((route) => route.path === path)

describe('isRouteEnabled', () => {
  it('keeps GBrain enabled when the legacy docs module is disabled and no explicit gbrain flag exists', () => {
    const gbrainRoute = byPath('/gbrain')

    expect(gbrainRoute).toBeDefined()
    expect(gbrainRoute?.module).toBe('gbrain')
    expect(isRouteEnabled(gbrainRoute!, { docs: false })).toBe(true)
  })

  it('gates each menu item on its own module and only an explicit false disables it', () => {
    for (const [path, module] of [
      ['/', 'dashboard'],
      ['/attention', 'attention'],
      ['/automations', 'cron'],
      ['/usage', 'costs'],
      ['/services', 'services'],
      ['/ollama', 'ollamaMonitor'],
      ['/settings', 'settings'],
      ['/councils', 'councils'],
    ] as const) {
      const route = byPath(path)
      expect(route?.module).toBe(module)
      expect(isRouteEnabled(route!, { [module]: false })).toBe(false)
      expect(isRouteEnabled(route!, { [module]: true })).toBe(true)
      expect(isRouteEnabled(route!, {})).toBe(true)
    }
  })
})

describe('navigation hierarchy', () => {
  it('exposes the decided primary destinations in order', () => {
    expect(primarySidebarRoutes.map((route) => route.path)).toEqual([
      '/',
      '/attention',
      '/automations',
      '/usage',
      '/services',
      '/ollama',
    ])

    expect(byPath('/ollama')).toMatchObject({
      label: 'Local models',
      section: 'run',
      description: 'Ollama health and loaded models',
    })
  })

  it('labels and groups the primary destinations per the design reference', () => {
    expect(primarySidebarRoutes.map((route) => [route.label, route.section])).toEqual([
      ['Brain', undefined],
      ['Attention', 'operate'],
      ['Automations', 'operate'],
      ['Usage', 'know'],
      ['Services', 'run'],
      ['Local models', 'run'],
    ])
  })

  it('keeps settings and governance in utility navigation', () => {
    expect(utilitySidebarRoutes.map((route) => route.path)).toEqual(['/settings', '/councils'])
  })

  it('keeps Knowledge and Calendar routed but out of the menu', () => {
    for (const path of ['/gbrain', '/calendar']) {
      expect(byPath(path)?.nav).toBe(false)
    }
  })

  it('defines every route path only once', () => {
    const paths = appRoutes.map((route) => route.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('keeps the compatibility redirects hidden from navigation', () => {
    for (const [path, module] of [
      ['/cron', 'cron'],
      ['/costs', 'costs'],
    ] as const) {
      expect(byPath(path)).toMatchObject({ module, nav: false })
    }
  })

  it('turns every removed screen into a hidden redirect', () => {
    const removed = [
      '/work', '/sessions', '/systems', '/workshop', '/office', '/team', '/diagnostics',
      '/kanban', '/conversations', '/agents', '/memory', '/scout', '/aws', '/skills',
    ]
    const home = byPath('/work')?.component
    for (const path of removed) {
      const route = byPath(path)
      expect(route, path).toBeDefined()
      expect(route?.nav, path).toBe(false)
      expect(route?.icon, path).toBeUndefined()
      expect(route?.component, path).toBe(home)
      expect(primarySidebarRoutes.concat(utilitySidebarRoutes)).not.toContain(route)
    }
  })
})
