import { Button } from '../../components/ui'
import { plainWords } from './lib'
import styles from './ActionList.module.css'
import type { OperationCapability } from './types'

/** One row per action: the button, and one line saying what it does or why it is off. */
export function ActionList({
  actions,
  running,
  onRun,
}: {
  actions: OperationCapability[]
  running: string | null
  onRun: (action: OperationCapability) => void
}) {
  return (
    <ul className={styles.list}>
      {actions.map((action) => {
        const isRunning = running === action.id
        return (
          <li key={action.id} className={styles.item}>
            <Button
              size="sm"
              loading={isRunning}
              disabled={!action.enabled || running !== null}
              onClick={() => onRun(action)}
            >
              {action.label}
            </Button>
            <span className={styles.text}>
              {plainWords(action.enabled ? action.description : action.disabledReason || 'Not available right now')}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
