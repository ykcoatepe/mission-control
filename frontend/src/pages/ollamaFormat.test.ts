import { describe, expect, it } from 'vitest'
import { describeTokenUsage, formatMiB, formatSize, formatTokens, gpuLoadLabel, splitLocalTokens } from './ollamaFormat'

describe('sizes use one decimal base', () => {
  it('formats bytes in decimal units, matching the model sizes Ollama reports', () => {
    expect(formatSize(16_500_000_000)).toBe('16.5 GB')
    expect(formatSize(137_438_953_472)).toBe('137.4 GB')
    expect(formatSize(93_805_674_496)).toBe('93.8 GB')
    expect(formatSize(1_500_000)).toBe('1.5 MB')
    expect(formatSize(999)).toBe('999 B')
  })

  it('converts MiB readings to the same base: 1217 MiB is 1.3 GB, not 1.2', () => {
    expect(formatMiB(1217)).toBe('1.3 GB')
    expect(formatMiB(4555)).toBe('4.8 GB')
    expect(formatMiB(512)).toBe('536.9 MB')
  })

  it('a missing reading is a dash; zero is a real zero', () => {
    for (const missing of [null, undefined, NaN, Infinity, -1]) {
      expect(formatSize(missing)).toBe('—')
      expect(formatMiB(missing)).toBe('—')
    }
    expect(formatSize(0)).toBe('0 B')
    expect(formatMiB(0)).toBe('0 B')
  })
})

describe('formatTokens', () => {
  it('never turns a missing count into 0', () => {
    for (const missing of [null, undefined, NaN, -5]) expect(formatTokens(missing)).toBe('—')
    expect(formatTokens(0)).toBe('0')
  })

  it('abbreviates large counts', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(45_220)).toBe('45.2K')
    expect(formatTokens(4_200)).toBe('4.20K')
    expect(formatTokens(9_467_280_338)).toBe('9.47B')
  })
})

describe('token usage above the models table', () => {
  const usage = new Map([
    ['llama3:8b', { tokens: 4_200 }],
    ['qwen3.8-flash-next-ud-q3_k_xl', { tokens: 45_220 }],
  ])

  it('splits usage into listed models and everything else', () => {
    expect(splitLocalTokens(usage, new Set(['llama3:8b']))).toEqual({ listed: 4_200, other: 45_220 })
    expect(splitLocalTokens(usage, new Set())).toEqual({ listed: 0, other: 49_420 })
    expect(splitLocalTokens(new Map(), new Set(['llama3:8b']))).toEqual({ listed: 0, other: 0 })
  })

  it('states only what the rows show, and says where the rest comes from', () => {
    expect(describeTokenUsage({ listed: 4_200, other: 0 }, 'This month')).toBe('4.20K tokens across these models · this month')
    expect(describeTokenUsage({ listed: 0, other: 45_220 }, 'This month')).toBe(
      'No token usage recorded for these models · 45.2K more by local endpoints not in this list · this month',
    )
    expect(describeTokenUsage({ listed: 0, other: 0 }, 'Today')).toBe('No token usage recorded for these models · today')
  })
})

describe('gpuLoadLabel', () => {
  it('names the Apple counter for what it is, not as memory pressure', () => {
    expect(gpuLoadLabel('apple-ioreg')).toBe('Tiler load')
    expect(gpuLoadLabel('nvidia-smi')).toBe('Memory controller load')
    expect(gpuLoadLabel(null)).toBe('Memory controller load')
  })
})
