import { describe, expect, it } from 'vitest'
import { buildSetupPayload, detectedLines, gatewayLines, nameError, suggestName } from './lib'
import type { SetupStatus } from './lib'

const status = (overrides: Partial<SetupStatus> = {}): SetupStatus => ({
  needsSetup: true,
  gatewayRunning: null,
  gatewayPort: 18789,
  gatewayVersion: null,
  detectedConfig: { model: null, channels: null, agentName: null, workspacePath: null, gatewayTokenConfigured: null },
  ...overrides,
})

describe('setup payload', () => {
  it('sends only the name when no token was typed', () => {
    expect(buildSetupPayload({ name: '  My Control  ', token: '   ' })).toEqual({ dashboardName: 'My Control' })
  })

  it('adds the gateway token only when one was typed', () => {
    expect(buildSetupPayload({ name: 'X', token: ' abc ' })).toEqual({ dashboardName: 'X', gateway: { token: 'abc' } })
  })

  it('never sends removed modules, scout, or a port', () => {
    const payload = buildSetupPayload({ name: 'X', token: 't' }) as Record<string, unknown>
    for (const key of ['modules', 'scout', 'port']) expect(payload).not.toHaveProperty(key)
    expect(Object.keys(payload).sort()).toEqual(['dashboardName', 'gateway'])
  })
})

describe('name', () => {
  it('requires a name of sensible length', () => {
    expect(nameError('')).not.toBeNull()
    expect(nameError('   ')).not.toBeNull()
    expect(nameError('Mission Control')).toBeNull()
    expect(nameError('x'.repeat(121))).not.toBeNull()
  })

  it('starts with the detected dashboard name as reported, and is empty when nothing was detected', () => {
    const detected = (dashboardName: string | null | undefined, agentName: string | null = null) =>
      status({ detectedConfig: { ...status().detectedConfig!, dashboardName, agentName } })
    expect(suggestName(null)).toBe('')
    expect(suggestName(status())).toBe('')
    expect(suggestName(status({ detectedConfig: null }))).toBe('')
    expect(suggestName(detected('   '))).toBe('')
    expect(suggestName(detected(null))).toBe('')
    expect(suggestName(detected('Mission Control'))).toBe('Mission Control')
    expect(suggestName(detected(' Ops Deck '))).toBe('Ops Deck')
  })

  it('does not use the agent name as the dashboard name', () => {
    expect(suggestName(status({ detectedConfig: { ...status().detectedConfig!, dashboardName: null, agentName: 'Mudur' } }))).toBe('')
    expect(suggestName(status({ detectedConfig: { ...status().detectedConfig!, dashboardName: 'Mission Control', agentName: 'Mudur' } }))).toBe('Mission Control')
  })

  it('never makes a name up: no suffix and no default', () => {
    expect(suggestName(status({ detectedConfig: { ...status().detectedConfig!, dashboardName: null } }))).toBe('')
  })
})

describe('detection', () => {
  it('shows a detected model by the catalog name, else by its id', () => {
    const detected = status({ detectedConfig: { ...status().detectedConfig!, model: 'openai/gpt-5.6-sol' } })
    expect(detectedLines(detected, { 'openai/gpt-5.6-sol': 'GPT-5.6-Sol' })).toEqual([{ label: 'Model', value: 'GPT-5.6-Sol' }])
    expect(detectedLines(detected, {})).toEqual([{ label: 'Model', value: 'openai/gpt-5.6-sol' }])
    expect(detectedLines(detected, null)).toEqual([{ label: 'Model', value: 'openai/gpt-5.6-sol' }])
    expect(detectedLines(detected, { constructor: 'x' })).toEqual([{ label: 'Model', value: 'openai/gpt-5.6-sol' }])
  })

  it('says the gateway was not checked when the server did not measure it', () => {
    const [gateway, port, token] = gatewayLines(status())
    expect(gateway).toEqual({ label: 'Gateway', value: 'Not checked here', state: 'unavailable' })
    expect(port).toMatchObject({ label: 'Port', value: '18789' })
    expect(token).toEqual({ label: 'Token', value: 'Not read', state: 'unavailable' })
  })

  it('reports a measured gateway and a configured token, without ever carrying a token value', () => {
    const lines = gatewayLines(status({ gatewayRunning: true, gatewayVersion: '2026.11', detectedConfig: { ...status().detectedConfig!, gatewayTokenConfigured: true } }))
    expect(lines.map((l) => l.value)).toEqual(['Running', '18789', '2026.11', 'Configured locally'])
    expect(JSON.stringify(lines)).not.toMatch(/secret|bearer/i)
  })

  it('does not crash on a null channel list or a missing detected block', () => {
    expect(detectedLines(status())).toEqual([])
    expect(detectedLines(status({ detectedConfig: null }))).toEqual([])
    expect(gatewayLines(status({ detectedConfig: null, gatewayPort: null }))[1]).toMatchObject({ value: 'Not read' })
    expect(detectedLines(status({ detectedConfig: { ...status().detectedConfig!, model: 'amazon-bedrock/claude', channels: ['telegram'], workspacePath: '/w' } }))).toEqual([
      { label: 'Model', value: 'claude' },
      { label: 'Channels', value: 'telegram' },
      { label: 'Workspace', value: '/w' },
    ])
  })
})
