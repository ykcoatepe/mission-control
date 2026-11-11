import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import styles from './Disclosure.module.css'

/**
 * The one small disclosure of the Brain page: a quiet text button with a chevron that folds a group
 * away. "N more for information" and the recovered history both use it, so they look and behave the
 * same (aria-expanded, aria-controls, hover, focus ring, 28px tall). Folded by default.
 */
export function Disclosure({
  summary,
  tone = 'muted',
  children,
}: {
  summary: ReactNode
  /** `muted` is text-3 (information); `secondary` is text-2 (a summary line worth reading). */
  tone?: 'muted' | 'secondary'
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const regionId = useId()
  return (
    <div className={styles.disclosure}>
      <button
        type="button"
        className={styles.toggle}
        data-tone={tone}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown size={14} className={styles.chevron} aria-hidden="true" />
        <span>{summary}</span>
      </button>
      <div id={regionId} className={styles.region} hidden={!open}>
        {children}
      </div>
    </div>
  )
}
