import { describe, expect, it } from 'vitest'
import { changedRouting, heartbeatError, routingErrors, routingFieldError } from './lib'

const baseline = { main: 'ollama/qwen3.6:35b', subagent: 'ollama/qwen3.6:35b', heartbeat: '' }

describe('changedRouting', () => {
  it('sends only the fields that changed', () => {
    expect(changedRouting(baseline, { ...baseline, heartbeat: 'ollama/small' })).toEqual({ heartbeat: 'ollama/small' })
    expect(changedRouting(baseline, { ...baseline, main: 'anthropic/claude-sonnet-5-5' })).toEqual({ main: 'anthropic/claude-sonnet-5-5' })
  })

  it('sends nothing when nothing changed', () => {
    expect(changedRouting(baseline, { ...baseline })).toEqual({})
  })

  it('clearing the heartbeat model is a real change (an empty string unsets it)', () => {
    expect(changedRouting({ ...baseline, heartbeat: 'ollama/small' }, baseline)).toEqual({ heartbeat: '' })
  })
})

describe('routing validation mirrors the server', () => {
  it('accepts model identifiers and rejects spaces, leading symbols and empties', () => {
    expect(routingFieldError('main', 'amazon-bedrock/anthropic.claude-3:0')).toBeNull()
    expect(routingFieldError('main', 'bad model')).not.toBeNull()
    expect(routingFieldError('subagent', '-flag')).not.toBeNull()
    expect(routingFieldError('main', '')).not.toBeNull()
    expect(routingFieldError('subagent', '')).not.toBeNull()
  })

  it('only the heartbeat model may be empty', () => {
    expect(routingFieldError('heartbeat', '')).toBeNull()
  })

  it('reports errors per changed field only', () => {
    expect(routingErrors({ main: 'bad model', heartbeat: '' })).toEqual({ main: 'Choose a valid model.' })
    expect(routingErrors({})).toEqual({})
  })
})

describe('heartbeatError', () => {
  it('accepts the server duration format', () => {
    for (const ok of ['30m', '1h', '45s', '250ms', '2d']) expect(heartbeatError(ok)).toBeNull()
  })

  it('rejects values the server would answer 400 for, including the old "30min" and "off"', () => {
    for (const bad of ['30min', 'off', '', '1 h', 'h', '-5m']) expect(heartbeatError(bad)).not.toBeNull()
  })
})
