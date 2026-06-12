import { describe, expect, it } from 'vitest'
import { appRoutes, isRouteEnabled } from './appRoutes'

const diagnosticsRoute = appRoutes.find((route) => route.path === '/diagnostics')

describe('isRouteEnabled', () => {
  it('keeps Diagnostics visible when settings is disabled but a diagnostic module is enabled', () => {
    expect(diagnosticsRoute).toBeDefined()
    expect(isRouteEnabled(diagnosticsRoute!, {
      settings: false,
      docs: true,
      scout: false,
      aws: false,
      skills: false,
    })).toBe(true)
  })

  it('hides Diagnostics when settings and all diagnostic modules are disabled', () => {
    expect(diagnosticsRoute).toBeDefined()
    expect(isRouteEnabled(diagnosticsRoute!, {
      settings: false,
      docs: false,
      scout: false,
      aws: false,
      skills: false,
    })).toBe(false)
  })

  it('hides Diagnostics when settings is enabled but all diagnostic modules are disabled', () => {
    expect(diagnosticsRoute).toBeDefined()
    expect(isRouteEnabled(diagnosticsRoute!, {
      settings: true,
      docs: false,
      scout: false,
      aws: false,
      skills: false,
    })).toBe(false)
  })
})
