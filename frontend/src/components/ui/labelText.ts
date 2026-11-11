import { isValidElement } from 'react'
import type { ReactNode } from 'react'

/** The plain text of a label, so the button's name never depends on how its inner span is laid out or clipped. */
export function labelText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(labelText).join('')
  if (isValidElement<{ children?: ReactNode; 'aria-hidden'?: unknown }>(node)) {
    return node.props['aria-hidden'] === true || node.props['aria-hidden'] === 'true' ? '' : labelText(node.props.children)
  }
  return ''
}
