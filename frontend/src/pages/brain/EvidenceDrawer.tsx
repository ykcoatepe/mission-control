import { Link } from 'react-router-dom'
import styles from './BrainHome.module.css'
import type { DrawerSelection } from './types'

export function EvidenceDrawer({
  selection,
  onClose,
}: {
  selection: DrawerSelection | null
  onClose: () => void
}) {
  if (!selection) return null

  return (
    <aside className={styles.drawer} aria-labelledby="evidence-drawer-title">
      <header className={styles.drawerHeader}>
        <div>
          <span>{selection.system}</span>
          <h2 id="evidence-drawer-title">{selection.title}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close evidence drawer">×</button>
      </header>
      <div className={styles.drawerBody}>
        <section>
          <h3>Current conclusion</h3>
          <p>{selection.detail}</p>
        </section>
        <section>
          <h3>Evidence</h3>
          {selection.evidence.length === 0 ? (
            <p className={styles.drawerEmpty}>No evidence is attached to this conclusion.</p>
          ) : (
            <div className={styles.drawerEvidence}>
              {selection.evidence.map((item) => (
                <article key={item.id} data-state={item.status}>
                  <strong>{item.summary}</strong>
                  <span>{item.sourceRef}</span>
                  <time dateTime={item.observedAt ?? undefined}>
                    {item.observedAt || 'Observation time unavailable'}
                  </time>
                </article>
              ))}
            </div>
          )}
        </section>
        {selection.caveats.length > 0 ? (
          <section>
            <h3>Caveats</h3>
            <ul>
              {selection.caveats.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        ) : null}
        <Link className={styles.drawerDetailLink} to={selection.detailHref}>
          Open specialized detail
        </Link>
      </div>
    </aside>
  )
}
