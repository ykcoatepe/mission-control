/**
 * Plain-text helpers for brain pages and search results. Nothing here produces HTML:
 * the parser returns data, and the view renders it as React text nodes.
 */

/** Absolute home paths read as "~/…": `/Users/name/clawd/x` becomes `~/clawd/x`. */
export function shortenHome(text: string): string {
  return text.replace(/(^|[\s"'`([=:])(?:\/Users|\/home)\/[^/\s"'`)\]]+\//g, '$1~/')
}

export type Inline = { kind: 'text' | 'strong' | 'em' | 'code'; text: string }

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])|(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])|!?\[([^\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g

/** Inline markup as data: code, bold, italic; a link keeps its text and drops the address. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) })
    if (match[2] !== undefined) out.push({ kind: 'code', text: match[2].trim() })
    else if (match[3] !== undefined) out.push({ kind: 'strong', text: match[3] })
    else if (match[4] !== undefined) out.push({ kind: 'em', text: match[4] })
    else if (match[5] !== undefined) out.push({ kind: 'em', text: match[5] })
    else out.push({ kind: 'text', text: match[6] || match[7] || '' })
    last = at + match[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** A search snippet as one line of plain text: no heading, list, emphasis, link or code markers. */
export function plainSnippet(text: string | null | undefined): string {
  if (!text) return ''
  const lines = text
    .replace(/```[^\n]*\n?/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, ''))
  return parseInline(lines.join(' '))
    .map((part) => part.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

export type PageBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' }

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const NUMBERED = /^\s{0,3}\d+[.)]\s+(.*)$/
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/

/**
 * A light reading of markdown: headings, lists, fenced code and paragraphs. Anything else stays as
 * paragraph text with its line breaks. Source code (a `code` page) should not go through this.
 */
export function parsePageText(content: string): PageBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const blocks: PageBlock[] = []
  let i = 0
  // Front matter is shown as it is, as code.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) {
      blocks.push({ kind: 'code', text: lines.slice(1, end).join('\n') })
      i = end + 1
    }
  }
  while (i < lines.length) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i += 1
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      i += 1
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: Math.min(3, heading[1].length) as 1 | 2 | 3, text: heading[2] })
      i += 1
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i += 1
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      const pattern = bullet ? BULLET : NUMBERED
      const items: string[] = []
      while (i < lines.length) {
        const item = pattern.exec(lines[i])
        if (item) {
          items.push(item[1])
          i += 1
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length > 0) {
          items[items.length - 1] += ` ${lines[i].trim()}`
          i += 1
        } else break
      }
      blocks.push({ kind: 'list', ordered: Boolean(numbered), items })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !BULLET.test(lines[i]) &&
      !NUMBERED.test(lines[i])
    ) {
      para.push(lines[i].replace(/^\s{0,3}>\s?/, ''))
      i += 1
    }
    blocks.push({ kind: 'paragraph', text: para.join('\n') })
  }
  return blocks
}
