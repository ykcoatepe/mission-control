import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Open modals, innermost last. Only the innermost one handles Esc and Tab (a Dialog over a Drawer closes alone). */
const openModals: object[] = []

/**
 * Shared behaviour of Drawer and Dialog while open: focus moves into the
 * container, Tab is trapped, Esc closes, and focus returns to the element that
 * had it before opening.
 */
export function useModal(
  open: boolean,
  onClose: () => void,
  containerRef: RefObject<HTMLElement | null>,
  /** Where focus goes on close when nothing meaningful had it on open (Safari does not focus a clicked button). */
  fallbackFocus?: () => HTMLElement | null,
) {
  const onCloseRef = useRef(onClose)
  const fallbackRef = useRef(fallbackFocus)
  useEffect(() => {
    onCloseRef.current = onClose
    fallbackRef.current = fallbackFocus
  })

  useEffect(() => {
    if (!open) return
    const container = containerRef.current
    if (!container) return
    const token = {}
    openModals.push(token)
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement)

    // Prefer an explicit autofocus target, then the first control, then the container itself.
    const initial = container.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? container
    initial.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== token) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === container)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      } else if (!container.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const at = openModals.indexOf(token)
      if (at >= 0) openModals.splice(at, 1)
      const meaningful = previouslyFocused && previouslyFocused !== document.body && document.contains(previouslyFocused)
      const target = meaningful ? previouslyFocused : (fallbackRef.current?.() ?? null)
      if (target && document.contains(target)) target.focus()
    }
  }, [open, containerRef])
}
