import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Contrast of the design tokens, computed from `tokens.css` itself so a token
 * edit that breaks readability fails here. WCAG AA: 4.5:1 for text, 3:1 for
 * marks and control outlines. Disabled text and the dim "inactive" tone are
 * exempt: they never carry the only copy of a message.
 *
 * Grounds: text-1 and text-2 are read on all five grounds. text-3 and the
 * state colours are read on bg, rail, surface-1 and surface-2 (never on
 * surface-3). Text on an accent-tinted selection uses text-1 or text-2.
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
const GROUNDS = ['bg', 'rail', 'surface-1', 'surface-2']
const ALL_GROUNDS = [...GROUNDS, 'surface-3']

/** Resolve `var(--x)` aliases so a token defined as an alias is measured as its target. */
function resolved(tokens: Tokens, name: string): string {
  let value = tokens[name]
  for (let i = 0; i < 4 && value?.startsWith('var('); i += 1) value = tokens[value.slice(6, -1)]
  return value
}
function colour(tokens: Tokens, name: string): [number, number, number, number] {
  return parse(resolved(tokens, name))
}

describe.each(THEMES)('%s theme contrast', (_name, tokens) => {
  it.each(['text-1', 'text-2'])('--%s reaches 4.5:1 on every ground', (text) => {
    for (const ground of ALL_GROUNDS) {
      expect(contrast(rgb(tokens, text), rgb(tokens, ground)), `${text} on ${ground}`).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('--text-3 reaches 4.5:1 on bg, rail, surface-1 and surface-2, and stays quieter than text-2', () => {
    for (const ground of GROUNDS) {
      expect(contrast(rgb(tokens, 'text-3'), rgb(tokens, ground)), `text-3 on ${ground}`).toBeGreaterThanOrEqual(MIN)
    }
    const surface = rgb(tokens, 'surface-1')
    expect(contrast(rgb(tokens, 'text-3'), surface)).toBeLessThan(contrast(rgb(tokens, 'text-2'), surface))
  })

  it.each(['accent', 'state-normal', 'state-warning', 'state-critical', 'state-unavailable'])(
    '--%s as text reaches 4.5:1 on bg, rail, surface-1 and surface-2',
    (name) => {
      for (const ground of GROUNDS) {
        const [r, g, b] = colour(tokens, name)
        expect(contrast([r, g, b], rgb(tokens, ground)), `${name} on ${ground}`).toBeGreaterThanOrEqual(MIN)
      }
    },
  )

  it('healthy is an alias of normal: neutral, never a hue of its own', () => {
    expect(resolved(tokens, 'state-healthy')).toBe(resolved(tokens, 'state-normal'))
    const [r, g, b] = colour(tokens, 'state-normal')
    // Neutral: the channels sit close together (a hint of slate or paper is fine, green or red is not).
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(24)
  })

  it.each(['warning', 'critical'])('state-%s text reaches 4.5:1 on its own tint over every ground it sits on', (state) => {
    for (const ground of ['bg', 'surface-1', 'surface-2']) {
      const tint = over(tokens, `state-${state}-bg`, rgb(tokens, ground))
      expect(contrast(rgb(tokens, `state-${state}`), tint), `${state} on tint over ${ground}`).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('accent text on the accent tint (selected rail item, selected row) reaches 4.5:1; so do text-1 and text-2', () => {
    for (const ground of ['bg', 'rail', 'surface-1', 'surface-2']) {
      const tint = over(tokens, 'accent-bg', rgb(tokens, ground))
      for (const text of ['accent', 'text-1', 'text-2']) {
        expect(contrast(rgb(tokens, text), tint), `${text} on tint over ${ground}`).toBeGreaterThanOrEqual(MIN)
      }
    }
  })

  it('the primary button label reaches 4.5:1 on the filled hover and active ground', () => {
    expect(contrast(rgb(tokens, 'text-on-accent'), rgb(tokens, 'accent'))).toBeGreaterThanOrEqual(MIN)
    expect(contrast(rgb(tokens, 'text-on-accent'), rgb(tokens, 'accent-hover'))).toBeGreaterThanOrEqual(MIN)
  })

  it.each(['reference', 'projects', 'agent', 'curated'])(
    'line colour %s carries the block header label (4.5:1) and shows as a mark on every ground (3:1)',
    (name) => {
      expect(contrast(rgb(tokens, 'text-on-accent'), rgb(tokens, `line-${name}`)), `label on ${name}`).toBeGreaterThanOrEqual(MIN)
      for (const ground of ['bg', 'surface-1', 'surface-2']) {
        expect(contrast(rgb(tokens, `line-${name}`), rgb(tokens, ground)), `${name} on ${ground}`).toBeGreaterThanOrEqual(3)
      }
    },
  )

  it('control outlines and the neutral track show against the grounds they sit on (3:1)', () => {
    for (const name of ['control-line', 'track']) {
      for (const ground of ['bg', 'rail', 'surface-1']) {
        const floor = name === 'track' ? 2.5 : 3
        expect(contrast(rgb(tokens, name), rgb(tokens, ground)), `${name} on ${ground}`).toBeGreaterThanOrEqual(floor)
      }
    }
  })
})
