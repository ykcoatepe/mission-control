import { Notice, Panel } from '../../components/ui'
import { ActionList } from './ActionList'
import { visibleActions } from './lib'
import styles from './MaintenancePanel.module.css'
import type { OperationCapability } from './types'

export function MaintenancePanel({
  capabilities,
  running,
  onRun,
}: {
  capabilities: OperationCapability[] | null
  running: string | null
  onRun: (action: OperationCapability) => void
}) {
  const visible = capabilities ? visibleActions(capabilities) : null
  const checks = visible?.filter((action) => action.safetyClass === 'R0') ?? []
  const changes = visible?.filter((action) => action.safetyClass === 'W1') ?? []
  return (
    <Panel title="Maintenance" description="Checks run at once. Changes ask before they run.">
      {visible === null ? (
        <Notice tone="warning">Maintenance actions could not be read, so none are offered.</Notice>
      ) : visible.length === 0 ? (
        <p className={styles.none}>No maintenance actions are available.</p>
      ) : (
        <div className={styles.groups}>
          {checks.length > 0 && (
            <section aria-labelledby="maint-check">
              <h3 id="maint-check" className={styles.heading}>
                Check
              </h3>
              <ActionList actions={checks} running={running} onRun={onRun} />
            </section>
          )}
          {changes.length > 0 && (
            <section aria-labelledby="maint-change">
              <h3 id="maint-change" className={styles.heading}>
                Change (asks first)
              </h3>
              <ActionList actions={changes} running={running} onRun={onRun} />
            </section>
          )}
        </div>
      )}
    </Panel>
  )
}
