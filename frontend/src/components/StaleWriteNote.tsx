import { Notice } from './ui'
import { STALE_WRITE_NOTE, UNCONFIRMED_NOTE, UNCONFIRMED_TITLE } from '../lib/writes'

/**
 * Shown after a write that went through but is not fully visible yet. A calm line when only the list is behind;
 * a warning, never a success, when the system has not confirmed the change at all.
 */
export function StaleWriteNote({ show, unconfirmed = false }: { show: boolean; unconfirmed?: boolean }) {
  if (!show) return null
  if (unconfirmed) {
    return (
      <Notice tone="warning" title={UNCONFIRMED_TITLE}>
        {UNCONFIRMED_NOTE}
      </Notice>
    )
  }
  return <Notice tone="info">{STALE_WRITE_NOTE}</Notice>
}
