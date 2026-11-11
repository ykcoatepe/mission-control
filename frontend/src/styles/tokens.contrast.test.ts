import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Text contrast of the design tokens, computed from `tokens.css` itself so a
 * token edit that breaks readability fails here. WCAG AA for normal text is
 * 4.5:1. Disabled text and decorative state colours (dots, borders, the dim
 * "inactive" tone) are exempt: they never carry the only copy of a message.
 */

const MIN = 4.5
const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8')

type Rgb = [number, number, number]
type Tokens = Record<string, string>

function blockBody(selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`tokens.css has no ${selector} block`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  return css.slice(open + 1, close)
}

function declarations(body: string): Tokens {
  const out: Tokens = {}
  for (const match of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[match[1]] = match[2].trim()
  return out
}

const dark = declarations(blockBody(':root {'))
const light: Tokens = { ...dark, ...declarations(blockBody(":root[data-theme='light']")) }

/** A colour token as [r, g, b, alpha]. */
function parse(value: string): [number, number, number, number] {
  const hex = value.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  const fn = value.match(/^rgba?\(([^)]+)\)$/)
  if (!fn) throw new Error(`unsupported colour ${value}`)
  const parts = fn[1].split(',').map((part) => Number(part.trim()))
  return [parts[0], parts[1], parts[2], parts[3] ?? 1]
}

function rgb(tokens: Tokens, name: string): Rgb {
  const value = tokens[name]
  if (!value) throw new Error(`missing token --${name}`)
  const [r, g, b] = parse(value)
  return [r, g, b]
}

/** A translucent token laid over an opaque surface. */
function over(tokens: Tokens, name: string, surface: Rgb): Rgb {
  const [r, g, b, a] = parse(tokens[name])
  return [r * a + surface[0] * (1 - a), g * a + surface[1] * (1 - a), b * a + surface[2] * (1 - a)]
}

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const THEMES: Array<[string, Tokens]> = [
  ['dark', dark],
  ['light', light],
]
const SURFACES = ['bg', 'surface-1', 'surface-2', 'surface-3']

describe.each(THEMES)('%s theme contrast', (_name, tokens) => {
  it.each(['text-1', 'text-2', 'text-3'])('--%s reaches 4.5:1 on every surface', (text) => {
    for (const surface of SURFACES) {
      expect(contrast(rgb(tokens, text), rgb(tokens, surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('keeps text-3 visibly quieter than text-2', () => {
    const surface = rgb(tokens, 'surface-1')
    expect(contrast(rgb(tokens, 'text-3'), surface)).toBeLessThan(contrast(rgb(tokens, 'text-2'), surface))
  })

  it.each(['accent', 'state-healthy', 'state-warning', 'state-critical'])(
    '--%s as text reaches 4.5:1 on the plain surfaces',
    (colour) => {
      for (const surface of ['bg', 'surface-1', 'surface-2']) {
        expect(contrast(rgb(tokens, colour), rgb(tokens, surface)), `${colour} on ${surface}`).toBeGreaterThanOrEqual(MIN)
      }
    },
  )

  it.each(['healthy', 'warning', 'critical'])('state-%s text reaches 4.5:1 on its own tinted background', (state) => {
    for (const surface of ['surface-1', 'surface-2']) {
      const tint = over(tokens, `state-${state}-bg`, rgb(tokens, surface))
      expect(contrast(rgb(tokens, `state-${state}`), tint), `${state} on tint over ${surface}`).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('accent text on the accent tint and label on the accent fill reach 4.5:1', () => {
    for (const surface of ['surface-1', 'surface-2']) {
      const tint = over(tokens, 'accent-bg', rgb(tokens, surface))
      expect(contrast(rgb(tokens, 'accent'), tint), `accent on tint over ${surface}`).toBeGreaterThanOrEqual(MIN)
      expect(contrast(rgb(tokens, 'text-3'), tint), `text-3 on tint over ${surface}`).toBeGreaterThanOrEqual(MIN)
    }
    expect(contrast(rgb(tokens, 'text-on-accent'), rgb(tokens, 'accent'))).toBeGreaterThanOrEqual(MIN)
  })
})
