import { Button, Panel, StateDot, TimeAgo } from '../../components/ui'
import { toUiState } from '../../lib/state'
import type { UiState } from '../../lib/state'
import { describeIncident, type NoteLine } from './lib'
import styles from './NotesPanel.module.css'
import type { IncidentBanner } from './types'

export interface RecoveredNote {
  key: string
  banner: IncidentBanner
}

/** Current notes and the recovered-regression history in one list. History never changes the verdict. */
export function NotesPanel({
  notes,
  recovered,
  onAcknowledge,
}: {
  notes: NoteLine[]
  recovered: RecoveredNote[]
  onAcknowledge: () => void
}) {
  const empty = notes.length === 0 && recovered.length === 0
  return (
    <Panel
      title="Notes"
      actions={
        recovered.length > 0 ? (
          <Button size="sm" onClick={onAcknowledge}>
            {recovered.length === 1 ? 'Acknowledge' : `Acknowledge all ${recovered.length}`}
          </Button>
        ) : undefined
      }
    >
      {empty ? (
        <p className={styles.none}>No notes.</p>
      ) : (
        <ul className={styles.list}>
          {notes.map((note) => (
            <li key={note.id} className={styles.item}>
              <StateDot state={note.state} />
              <span>{note.text}</span>
            </li>
          ))}
          {recovered.map(({ key, banner }) => {
            const { text, at } = describeIncident(banner)
            const state: UiState = toUiState(banner.status)
            return (
              <li key={key} className={styles.item} data-history>
                <StateDot state={state === 'unavailable' ? 'inactive' : state} />
                <span>
                  Recovered: {text}
                  {at && (
                    <>
                      {' '}
                      <TimeAgo value={at} className={styles.time} />
                    </>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
