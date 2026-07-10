import { sortAttention } from './lib'
import styles from './BrainHome.module.css'
import type { AttentionItem } from './types'

export function DecisionInbox({
  items,
  onSelect,
}: {
  items: AttentionItem[]
  onSelect: (item: AttentionItem) => void
}) {
  const sorted = sortAttention(items)

  return (
    <section className={styles.inbox} aria-labelledby="decision-inbox-title">
      <header className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>Operator queue</p>
          <h2 id="decision-inbox-title">Decision Inbox</h2>
        </div>
        <span>{sorted.length} need attention</span>
      </header>
      <div className={styles.inboxList}>
        {sorted.length === 0 ? (
          <p className={styles.empty}>
            No operator decision needs attention. Review system freshness before treating this as globally healthy.
          </p>
        ) : (
          sorted.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.inboxItem}
              data-severity={item.severity}
              onClick={() => onSelect(item)}
            >
              <span className={styles.inboxMeta}>
                <span>{item.system}</span>
                <span>{item.severity}</span>
              </span>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </button>
          ))
        )}
      </div>
    </section>
  )
}
