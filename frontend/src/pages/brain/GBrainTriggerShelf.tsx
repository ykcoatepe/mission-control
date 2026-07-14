import styles from './BrainHome.module.css'
import type { OperationCapability } from './types'

interface Props {
  actions: OperationCapability[]
  runningAction: string | null
  onRequestRun: (action: OperationCapability, trigger: HTMLButtonElement) => void
}

export function GBrainTriggerShelf({ actions, runningAction, onRequestRun }: Props) {
  const visible = actions.filter((action) => action.safetyClass !== 'W2')
  const runningLabel = visible.find((action) => action.id === runningAction)?.label
  const groups = [
    {
      id: 'diagnostics',
      label: 'Read-only diagnostics',
      description: 'Inspect current evidence without changing shared sources.',
      safetyClass: 'R0' as const,
      actions: visible.filter((action) => action.safetyClass === 'R0'),
    },
    {
      id: 'maintenance',
      label: 'Guarded maintenance',
      description: 'Change shared evidence only after explicit confirmation.',
      safetyClass: 'W1' as const,
      actions: visible.filter((action) => action.safetyClass === 'W1'),
    },
  ].filter((group) => group.actions.length > 0)

  return (
    <section id="gbrain-triggers" className={styles.triggerShelf} aria-labelledby="trigger-title">
      <header className={styles.panelHeader}>
        <div>
          <p className={styles.eyebrow}>Controlled operations</p>
          <h2 id="trigger-title">GBrain Triggers</h2>
        </div>
        <span aria-live="polite">
          {runningAction
            ? `Running ${runningLabel ?? runningAction}`
            : `${visible.length} allowlisted actions`}
        </span>
      </header>
      {visible.length === 0 ? (
        <p className={styles.empty}>No safe GBrain actions are currently available.</p>
      ) : (
        <div className={styles.triggerGroups}>
          {groups.map((group) => (
            <section
              key={group.id}
              className={styles.triggerGroup}
              data-safety={group.safetyClass}
              aria-labelledby={`trigger-group-${group.id}`}
            >
              <header className={styles.triggerGroupHeader}>
                <div>
                  <span>{group.safetyClass}</span>
                  <h3 id={`trigger-group-${group.id}`}>{group.label}</h3>
                </div>
                <small>{group.actions.length} actions</small>
              </header>
              <p className={styles.triggerGroupDescription}>{group.description}</p>
              <div className={styles.triggerGrid}>
                {group.actions.map((action) => {
                  const isRunning = runningAction === action.id
                  const status = isRunning
                    ? 'Running…'
                    : action.enabled
                      ? (action.requiresConfirmation ? 'Confirmation required' : 'Runs diagnostic directly')
                      : action.disabledReason

                  return (
                    <button
                      key={action.id}
                      type="button"
                      disabled={!action.enabled || Boolean(runningAction)}
                      data-safety={action.safetyClass}
                      aria-busy={isRunning || undefined}
                      onClick={(event) => onRequestRun(action, event.currentTarget)}
                    >
                      <span>{action.safetyClass}</span>
                      <strong>{action.label}</strong>
                      <p>{action.description}</p>
                      <small>{status}</small>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  )
}
