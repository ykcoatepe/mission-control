import { describe, expect, it } from 'vitest'
import { assignModelColors } from './lib'

describe('assignModelColors', () => {
  it('assigns a distinct color to every active model', () => {
    const assignments = assignModelColors([
      'Codex App Sessions / openai/gpt-5.5',
      'Claude Code / claude-fable-5',
      'Hermes / openai-codex/gpt-5.6-sol',
      'Claude Opus',
      'OpenClaw / openai/gpt-5.6-sol',
      'Hermes / openai-codex/gpt-5.5',
      'Qwen3.6',
    ])

    expect(new Set(assignments.values()).size).toBe(assignments.size)
  })

  it('keeps assignments distinct when active models exceed the curated palette', () => {
    const assignments = assignModelColors(
      Array.from({ length: 20 }, (_, index) => `model-${index + 1}`),
    )

    expect(assignments.size).toBe(20)
    expect(new Set(assignments.values()).size).toBe(20)
  })

  it('keeps colors for active models and returns inactive colors to the pool', () => {
    const previous = assignModelColors(['model-a', 'model-b', 'model-c'])
    const next = assignModelColors(['model-b', 'model-c', 'model-d'], previous)

    expect(next.get('model-b')).toBe(previous.get('model-b'))
    expect(next.get('model-c')).toBe(previous.get('model-c'))
    expect(next.get('model-d')).toBe(previous.get('model-a'))
    expect(next.has('model-a')).toBe(false)
  })

  it('deduplicates model names without making assignment case-sensitive', () => {
    const assignments = assignModelColors(['Claude Opus', ' claude opus ', 'GPT-5.6'])

    expect(assignments.size).toBe(2)
    expect(assignments.get('claude opus')).toBeDefined()
    expect(assignments.get('gpt-5.6')).toBeDefined()
  })
})
