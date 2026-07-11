import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import styles from './BrainHome.module.css'
import type { OperationsOverview, OperationSystem, OperationSystemId } from './types'

const positions: Record<OperationSystemId, { x: number; y: number }> = {
  gbrain: { x: 50, y: 50 },
  hermes: { x: 18, y: 28 },
  openclaw: { x: 82, y: 28 },
}

function nodePosition(x: number, y: number) {
  return { '--node-x': `${x}%`, '--node-y': `${y}%` } as CSSProperties
}

function mapProof(system: OperationSystem) {
  const proof = []
  if (!system.observedAt) proof.push('no current proof')
  if (system.caveats[0]) proof.push(system.caveats[0])
  return proof.length > 0 ? proof.join(' · ') : 'evidence available'
}

export function LivingBrainMap({
  overview,
  onSelectSystem,
}: {
  overview: OperationsOverview
  onSelectSystem: (system: OperationSystem) => void
}) {
  const systems = [
    overview.systems.gbrain,
    overview.systems.hermes,
    overview.systems.openclaw,
  ]

  return (
    <section className={styles.mapPanel} aria-labelledby="brain-map-title">
      <header className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>Shared operations core</p>
          <h2 id="brain-map-title">Living Brain Map</h2>
        </div>
        <span>live · read-first</span>
      </header>
      <div className={styles.mapCanvas}>
        <svg className={styles.mapConnections} viewBox="0 0 100 100" aria-hidden="true" preserveAspectRatio="none">
          <path d="M18 28 L50 50 L82 28" />
          <path d="M18 28 L18 74 L50 50 L82 74 L82 28" />
        </svg>
        {systems.map((system) => {
          const proof = mapProof(system)
          return (
            <button
              key={system.id}
              type="button"
              className={styles.mapNode}
              data-system={system.id}
              data-state={system.state}
              style={nodePosition(positions[system.id].x, positions[system.id].y)}
              aria-label={`${system.label}: ${system.state}, ${system.freshness}, ${proof}`}
              onClick={() => onSelectSystem(system)}
            >
              <span className={styles.nodeSignal} aria-hidden="true" />
              <strong>{system.label}</strong>
              <span>{system.state} · {system.freshness}</span>
              <small>{proof}</small>
            </button>
          )
        })}
        <Link
          className={styles.domainNode}
          style={nodePosition(18, 74)}
          to="/gbrain?tab=sources"
        >
          <strong>Sources</strong>
          <span>knowledge inputs</span>
        </Link>
        <a
          className={styles.domainNode}
          style={nodePosition(82, 74)}
          href="#gbrain-triggers"
        >
          <strong>Triggers</strong>
          <span>controlled actions</span>
        </a>
      </div>
    </section>
  )
}
