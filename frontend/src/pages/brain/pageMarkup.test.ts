import { describe, expect, it } from 'vitest'
import { parseInline, parsePageText, plainSnippet, shortenHome } from './pageMarkup'

describe('shortenHome', () => {
  it('writes absolute home paths as ~/…, wherever they sit in a title', () => {
    expect(shortenHome('/Users/yordamkocatepe/clawd/trader-assistant/README.md')).toBe('~/clawd/trader-assistant/README.md')
    expect(shortenHome('notes in /Users/someone/clawd/x and /home/dev/y/z')).toBe('notes in ~/clawd/x and ~/y/z')
    expect(shortenHome('src/Users/not-a-home.ts')).toBe('src/Users/not-a-home.ts')
    expect(shortenHome('data/agent-registry.json')).toBe('data/agent-registry.json')
  })
})

describe('plainSnippet', () => {
  it('strips heading, emphasis, list, code and link markers into one readable line', () => {
    expect(plainSnippet('**What:** Add an alias table to `gbrain` so "Sarah" resolves.\n\n**Why:** see [the doc](https://x.test/a).')).toBe(
      'What: Add an alias table to gbrain so "Sarah" resolves. Why: see the doc.',
    )
    expect(plainSnippet('# TODOS\n### F11\n- one\n- two\n1. three')).toBe('TODOS F11 one two three')
  })

  it('keeps identifiers and code intact', () => {
    expect(plainSnippet('snake_case_name and __init__ and a*b*c')).toBe('snake_case_name and __init__ and a*b*c')
    expect(plainSnippet('[JSON] data/agent-registry.json:1-147 module')).toBe('[JSON] data/agent-registry.json:1-147 module')
  })

  it('is empty for nothing', () => {
    expect(plainSnippet(null)).toBe('')
    expect(plainSnippet('')).toBe('')
  })
})

describe('parsePageText', () => {
  it('reads headings, lists, fenced code and paragraphs, and keeps line breaks', () => {
    const blocks = parsePageText('# TODOS\n\n### F11 — flag\n**Priority:** P3\nsecond line\n\n- a\n- b\n  more\n\n1. one\n2. two\n\n```ts\nconst x = a === b\n```\n')
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'TODOS' },
      { kind: 'heading', level: 3, text: 'F11 — flag' },
      { kind: 'paragraph', text: '**Priority:** P3\nsecond line' },
      { kind: 'list', ordered: false, items: ['a', 'b more'] },
      { kind: 'list', ordered: true, items: ['one', 'two'] },
      { kind: 'code', text: 'const x = a === b' },
    ])
  })

  it('never produces markup: HTML in the text is plain text in a block', () => {
    const blocks = parsePageText('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(blocks).toEqual([
      { kind: 'paragraph', text: '<script>alert(1)</script>' },
      { kind: 'paragraph', text: '<img src=x onerror=alert(1)>' },
    ])
    expect(parseInline('[click](javascript:alert(1)) <b>x</b>').map((p) => p.text).join('')).toBe('click <b>x</b>')
  })

  it('shows front matter as code and survives an unclosed fence', () => {
    expect(parsePageText('---\ntitle: x\n---\n\nbody')[0]).toEqual({ kind: 'code', text: 'title: x' })
    expect(parsePageText('```\nnever closed')).toEqual([{ kind: 'code', text: 'never closed' }])
    expect(parsePageText('')).toEqual([])
  })
})
