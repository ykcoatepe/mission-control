import { Notice } from './ui'
import { STALE_WRITE_NOTE } from '../lib/writes'

/** Shown after a successful write whose follow-up reading is not confirmed yet: a calm line, not an error. */
export function StaleWriteNote({ show }: { show: boolean }) {
  if (!show) return null
  return <Notice tone="info">{STALE_WRITE_NOTE}</Notice>
}
