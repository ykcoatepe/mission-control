import { Link } from 'react-router-dom'
import { timeAgo } from '../../lib/hooks'
import styles from './BrainHome.module.css'
import type { OperationSystem } from './types'

export function SystemStatusRail({ systems }: { systems: OperationSystem[] }) {
  return (
    <section className={styles.statusRail} aria-label="System evidence status">
      {systems.map((system) => (
        <Link
          key={system.id}
          to={system.detailHref}
          className={styles.statusCard}
          data-state={system.state}
        >
          <span className={styles.statusIdentity}>
            <span aria-hidden="true" className={styles.statusDot} />
            {system.label}
          </span>
          <strong className={styles.statusState}>{system.state}</strong>
          <span className={styles.statusProof}>
            {system.freshness}
            {system.observedAt ? ` · ${timeAgo(system.observedAt)}` : ' · no current proof'}
          </span>
          {system.caveats[0] ? <small className={styles.statusCaveat}>{system.caveats[0]}</small> : null}
        </Link>
      ))}
    </section>
  )
}
