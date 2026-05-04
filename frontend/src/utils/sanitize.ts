import DOMPurify from 'dompurify'

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export function markdownToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br />')
}

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['strong', 'code', 'br', 'em', 'span', 'p', 'ul', 'ol', 'li', 'a'],
    ALLOWED_ATTR: ['href', 'style', 'target'],
  })
}

export function renderSanitizedMarkdown(text: string): string {
  return sanitizeHtml(markdownToHtml(text))
}
