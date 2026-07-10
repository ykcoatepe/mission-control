import { timeAgo } from '../../lib/hooks'
import styles from './BrainHome.module.css'
import type { EvidenceItem } from './types'

export function EvidenceTimeline({
  evidence,
  onSelect,
}: {
  evidence: EvidenceItem[]
  onSelect: (item: EvidenceItem) => void
}) {
  const visibleEvidence = evidence.slice(0, 8)

  return (
    <section className={styles.timeline} aria-labelledby="evidence-title">
      <header className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>Observed state</p>
          <h2 id="evidence-title">Evidence Timeline</h2>
        </div>
        <span>latest cross-stack proof</span>
      </header>
      {visibleEvidence.length === 0 ? (
        <p className={styles.empty}>No cross-stack evidence is available yet.</p>
      ) : (
        <ol className={styles.timelineList}>
          {visibleEvidence.map((item) => (
            <li key={item.id} data-state={item.status}>
              <button type="button" onClick={() => onSelect(item)}>
                <span className={styles.timelineMeta}>
                  <span>{item.system}</span>
                  <span>{item.status}</span>
                </span>
                <strong>{item.summary}</strong>
                <time dateTime={item.observedAt ?? undefined}>
                  {item.observedAt ? timeAgo(item.observedAt) : 'unknown'}
                </time>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
