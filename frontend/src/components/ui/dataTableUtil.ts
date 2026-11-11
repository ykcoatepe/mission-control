import { Children, Fragment, isValidElement } from 'react'
import type { ReactNode } from 'react'

/** True when a cell renders nothing a person could read: null, undefined, booleans, blank text or only such parts. */
export function isEmptyCell(node: ReactNode): boolean {
  if (node === null || node === undefined || typeof node === 'boolean') return true
  if (typeof node === 'string') return node.trim() === ''
  if (typeof node === 'number' || typeof node === 'bigint') return false
  if (Array.isArray(node)) return node.every(isEmptyCell)
  if (isValidElement(node)) {
    // A fragment with only empty children is empty; any other element is real content.
    const props = node.props as { children?: ReactNode }
    return node.type === Fragment ? Children.toArray(props.children).every(isEmptyCell) : false
  }
  return false
}
