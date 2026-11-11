/**
 * Test helper: every button (and button-like control) in a rendered tree has an accessible name.
 * jsdom applies no CSS, so a name taken from content cannot be proved to survive a clipped or hidden label;
 * `Button` and `IconButton` therefore write the name as an aria-label (see Button.test.ts).
 */
const CONTROLS = 'button, [role="button"], [role="switch"], [role="tab"], [role="radio"]'

function visibleText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? ''
  if (node.nodeType !== 1) return ''
  const el = node as HTMLElement
  if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return ''
  return [...el.childNodes].map(visibleText).join('')
}

export function accessibleName(el: Element, root: Document | ShadowRoot = el.ownerDocument): string {
  const labelledby = el.getAttribute('aria-labelledby')
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => root.getElementById(id))
      .map((target) => (target ? visibleText(target) : ''))
      .join(' ')
      .trim()
    if (text) return text
  }
  const label = el.getAttribute('aria-label')?.trim()
  if (label) return label
  const own = visibleText(el).replace(/\s+/g, ' ').trim()
  if (own) return own
  // A button inside a <label> is named by it.
  return (el.closest('label') ? visibleText(el.closest('label') as Element) : '').replace(/\s+/g, ' ').trim()
}

/** Descriptions of the controls in `scope` that have no accessible name (empty when all are named). */
export function unnamedControls(scope: ParentNode = document): string[] {
  return [...scope.querySelectorAll(CONTROLS)].filter((el) => accessibleName(el) === '').map((el) => el.outerHTML.slice(0, 160))
}
