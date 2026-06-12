import { describe, it, expect } from 'vitest'
import {
  formatCurrency,
  formatPreciseCurrency,
  formatTokens,
  formatCompactTokenValue,
  formatComparisonValue,
  canonicalModelName,
  formatSessionName,
  hashColor,
} from './lib'

// ---------------------------------------------------------------------------
// formatCurrency
// ---------------------------------------------------------------------------

describe('formatCurrency', () => {
  it('formats a positive number', () => {
    expect(formatCurrency(1.5)).toBe('$1.50')
  })
  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00')
  })
  it('formats a large number', () => {
    expect(formatCurrency(1234.56)).toBe('$1,234.56')
  })
  it('formats negative values', () => {
    expect(formatCurrency(-5.75)).toBe('-$5.75')
  })
  it('treats Infinity as 0', () => {
    expect(formatCurrency(Infinity)).toBe('$0.00')
  })
  it('treats NaN as 0', () => {
    expect(formatCurrency(NaN)).toBe('$0.00')
  })
})

// ---------------------------------------------------------------------------
// formatPreciseCurrency
// ---------------------------------------------------------------------------

describe('formatPreciseCurrency', () => {
  it('uses toFixed(6) for small positive values under 0.01', () => {
    expect(formatPreciseCurrency(0.000123)).toBe('$0.000123')
  })
  it('uses toFixed(6) for small negative values with abs < 0.01', () => {
    expect(formatPreciseCurrency(-0.000123)).toBe('$-0.000123')
  })
  it('delegates to formatCurrency for values >= 0.01', () => {
    expect(formatPreciseCurrency(0.01)).toBe('$0.01')
    expect(formatPreciseCurrency(1.5)).toBe('$1.50')
  })
  it('treats 0 as formatCurrency (not < 0.01 branch)', () => {
    // Math.abs(0) > 0 is false, so falls through to formatCurrency
    expect(formatPreciseCurrency(0)).toBe('$0.00')
  })
  it('treats NaN as 0', () => {
    expect(formatPreciseCurrency(NaN)).toBe('$0.00')
  })
})

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe('formatTokens', () => {
  it('formats integer token counts with commas', () => {
    expect(formatTokens(1000000)).toBe('1,000,000')
  })
  it('rounds fractional values', () => {
    expect(formatTokens(1500.7)).toBe('1,501')
  })
  it('formats zero', () => {
    expect(formatTokens(0)).toBe('0')
  })
  it('treats NaN as 0', () => {
    expect(formatTokens(NaN)).toBe('0')
  })
  it('treats Infinity as 0', () => {
    expect(formatTokens(Infinity)).toBe('0')
  })
})

// ---------------------------------------------------------------------------
// formatCompactTokenValue
// ---------------------------------------------------------------------------

describe('formatCompactTokenValue', () => {
  it('formats large numbers compactly', () => {
    // 1000000 -> "1M"
    expect(formatCompactTokenValue(1_000_000)).toBe('1M')
  })
  it('formats thousands', () => {
    expect(formatCompactTokenValue(5_500)).toBe('5.5K')
  })
  it('formats small numbers without suffix', () => {
    expect(formatCompactTokenValue(42)).toBe('42')
  })
  it('treats NaN as 0', () => {
    expect(formatCompactTokenValue(NaN)).toBe('0')
  })
})

// ---------------------------------------------------------------------------
// formatComparisonValue
// ---------------------------------------------------------------------------

describe('formatComparisonValue', () => {
  it('returns "No previous baseline" for null', () => {
    expect(formatComparisonValue(null)).toBe('No previous baseline')
  })
  it('returns "No previous baseline" for undefined', () => {
    expect(formatComparisonValue(undefined)).toBe('No previous baseline')
  })
  it('returns "No previous baseline" for NaN', () => {
    expect(formatComparisonValue(NaN)).toBe('No previous baseline')
  })
  it('formats a valid number as currency', () => {
    expect(formatComparisonValue(2.5)).toBe('$2.50')
  })
  it('formats zero as currency', () => {
    expect(formatComparisonValue(0)).toBe('$0.00')
  })
})

// ---------------------------------------------------------------------------
// canonicalModelName
// ---------------------------------------------------------------------------

describe('canonicalModelName', () => {
  it('maps gpt-5.4-mini variant', () => {
    expect(canonicalModelName('gpt-5.4-mini')).toBe('GPT-5.4 Mini')
  })
  it('maps gpt-5.4-nano variant', () => {
    expect(canonicalModelName('openai/gpt-5.4-nano')).toBe('GPT-5.4 Nano')
  })
  it('maps gpt-5.4 (base)', () => {
    // must not match mini/nano first — they are checked first in the implementation
    expect(canonicalModelName('gpt-5.4')).toBe('GPT-5.4')
  })
  it('maps gpt-5.3-codex-spark', () => {
    expect(canonicalModelName('openai/gpt-5.3-codex-spark')).toBe('GPT-5.3 Codex Spark')
  })
  it('maps gpt-5.3', () => {
    expect(canonicalModelName('gpt-5.3')).toBe('GPT-5.3')
  })
  it('maps claude-sonnet-4-6', () => {
    expect(canonicalModelName('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6')
  })
  it('maps generic claude-sonnet', () => {
    expect(canonicalModelName('anthropic/claude-sonnet')).toBe('Claude Sonnet')
  })
  it('maps claude-opus', () => {
    expect(canonicalModelName('claude-opus')).toBe('Claude Opus')
  })
  it('maps claude-haiku', () => {
    expect(canonicalModelName('claude-haiku')).toBe('Claude Haiku')
  })
  it('strips ollama/ prefix and title-cases the model name', () => {
    expect(canonicalModelName('ollama/llama-3.2')).toBe('Llama 3.2')
  })
  it('strips ollama/ prefix and removes tag (colon part)', () => {
    expect(canonicalModelName('ollama/mistral:latest')).toBe('Mistral')
  })
  it('strips openrouter/ prefix', () => {
    // openrouter/meta-llama/llama-3-70b-instruct:nitro -> "Llama 3 70b Instruct"
    expect(canonicalModelName('openrouter/meta-llama/llama-3-70b-instruct')).toBe('Llama 3 70b Instruct')
  })
  it('returns the raw model string for unknown models', () => {
    expect(canonicalModelName('some-unknown-model')).toBe('some-unknown-model')
  })
  it('returns "Unknown" for empty string', () => {
    expect(canonicalModelName('')).toBe('Unknown')
  })
})

// ---------------------------------------------------------------------------
// formatSessionName
// ---------------------------------------------------------------------------

describe('formatSessionName', () => {
  it('extracts channel name from key containing #', () => {
    expect(formatSessionName('slack#general')).toBe('#general')
  })
  it('returns "Main Session" for agent:main:main', () => {
    expect(formatSessionName('agent:main:main')).toBe('Main Session')
  })
  it('returns "Sub-Agent" for keys containing :subagent:', () => {
    expect(formatSessionName('agent:foo:subagent:bar')).toBe('Sub-Agent')
  })
  it('uses displayName if provided and no special pattern matches', () => {
    expect(formatSessionName('random:key', 'My Session')).toBe('My Session')
  })
  it('falls back to last segment (truncated to 12 chars)', () => {
    // substring(0, 12) keeps 12 characters (indices 0–11)
    expect(formatSessionName('a:b:verylongsessionname')).toBe('verylongsess')
  })
})

// ---------------------------------------------------------------------------
// hashColor
// ---------------------------------------------------------------------------

describe('hashColor', () => {
  it('returns a string starting with # for any input', () => {
    const color = hashColor('test-model')
    expect(color).toMatch(/^#|^rgba/)
  })
  it('is deterministic — same input returns same color', () => {
    expect(hashColor('some-model')).toBe(hashColor('some-model'))
  })
  it('returns a value from the palette for an empty string', () => {
    const color = hashColor('')
    expect(typeof color).toBe('string')
    expect(color.length).toBeGreaterThan(0)
  })
})
