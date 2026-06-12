// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { markdownToHtml, sanitizeHtml, renderSanitizedMarkdown } from './sanitize'

// ---------------------------------------------------------------------------
// markdownToHtml
// ---------------------------------------------------------------------------

describe('markdownToHtml', () => {
  it('converts **bold** to <strong>', () => {
    expect(markdownToHtml('**hello**')).toBe('<strong>hello</strong>')
  })

  it('converts `code` to <code>', () => {
    expect(markdownToHtml('`foo`')).toBe('<code>foo</code>')
  })

  it('converts newlines to <br />', () => {
    expect(markdownToHtml('line1\nline2')).toBe('line1<br />line2')
  })

  it('escapes < and > characters', () => {
    const result = markdownToHtml('<script>')
    expect(result).toContain('&lt;script&gt;')
    expect(result).not.toContain('<script>')
  })

  it('escapes & characters', () => {
    expect(markdownToHtml('a & b')).toBe('a &amp; b')
  })

  it('escapes " characters', () => {
    expect(markdownToHtml('"quoted"')).toBe('&quot;quoted&quot;')
  })

  it("escapes ' characters", () => {
    expect(markdownToHtml("it's")).toBe('it&#39;s')
  })

  it('handles empty string', () => {
    expect(markdownToHtml('')).toBe('')
  })

  it('applies multiple transforms in one string', () => {
    const result = markdownToHtml('**bold** and `code`')
    expect(result).toBe('<strong>bold</strong> and <code>code</code>')
  })
})

// ---------------------------------------------------------------------------
// sanitizeHtml
// ---------------------------------------------------------------------------

describe('sanitizeHtml', () => {
  it('strips <script> tags', () => {
    const result = sanitizeHtml('<script>alert("xss")</script><strong>safe</strong>')
    expect(result).not.toContain('<script>')
    expect(result).toContain('<strong>safe</strong>')
  })

  it('strips onclick and other event handlers', () => {
    const result = sanitizeHtml('<strong onclick="evil()">text</strong>')
    expect(result).not.toContain('onclick')
    expect(result).toContain('<strong>')
  })

  it('allows allowed tags: strong, code, br, em, span, p, ul, ol, li, a', () => {
    const input = '<strong>b</strong><code>c</code><em>e</em>'
    const result = sanitizeHtml(input)
    expect(result).toContain('<strong>b</strong>')
    expect(result).toContain('<code>c</code>')
    expect(result).toContain('<em>e</em>')
  })

  it('allows href attribute on <a>', () => {
    const result = sanitizeHtml('<a href="https://example.com">link</a>')
    expect(result).toContain('href="https://example.com"')
  })

  it('strips disallowed tags like <div>', () => {
    const result = sanitizeHtml('<div class="x">text</div>')
    // DOMPurify strips the tag but may keep the text content
    expect(result).not.toContain('<div')
  })

  it('passes through empty string', () => {
    expect(sanitizeHtml('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// renderSanitizedMarkdown — composition
// ---------------------------------------------------------------------------

describe('renderSanitizedMarkdown', () => {
  it('converts markdown and sanitizes in one step', () => {
    const result = renderSanitizedMarkdown('**hello**')
    expect(result).toContain('<strong>hello</strong>')
  })

  it('escapes raw HTML that looks like XSS before sanitizing', () => {
    // The < and > are HTML-escaped by markdownToHtml, so the script tag is
    // passed to DOMPurify as literal text entities (not real tags) and survives.
    const result = renderSanitizedMarkdown('<script>evil()</script>')
    expect(result).not.toContain('<script>')
  })

  it('handles empty string', () => {
    expect(renderSanitizedMarkdown('')).toBe('')
  })
})
