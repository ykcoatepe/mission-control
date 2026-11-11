import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button, Panel, StateDot, TimeAgo } from '../../components/ui'
import { toUiState } from '../../lib/state'
import type { UiState } from '../../lib/state'
import { describeIncident, type NoteGroups } from './lib'
import styles from './NotesPanel.module.css'
import type { IncidentBanner } from './types'

export interface RecoveredNote {
  key: string
  banner: IncidentBanner
}

/**
 * Current notes and the recovered-regression history. What needs action is listed, coloured by its
 * state; everything the server marked as information sits behind one quiet disclosure. History never
 * changes the verdict.
 */
export function NotesPanel({
  notes,
  recovered,
  onAcknowledge,
}: {
  notes: NoteGroups
  recovered: RecoveredNote[]
  onAcknowledge: () => void
}) {
  const [open, setOpen] = useState(false)
  const infoId = useId()
  const { action, info } = notes
  const empty = action.length === 0 && info.length === 0 && recovered.length === 0
  const nothingToDo = action.length === 0 && recovered.length === 0
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
        <div className={styles.groups}>
          {nothingToDo ? (
            <p className={styles.none}>Nothing needs action.</p>
          ) : (
            <ul className={styles.list} aria-label="Needs action">
              {action.map((note) => (
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
          {info.length > 0 && (
            <div className={styles.info}>
              <button
                type="button"
                className={styles.toggle}
                aria-expanded={open}
                aria-controls={infoId}
                onClick={() => setOpen((value) => !value)}
              >
                <ChevronDown size={14} className={styles.chevron} aria-hidden="true" />
                {info.length} more for information
              </button>
              <ul id={infoId} className={styles.infoList} aria-label="For information" hidden={!open}>
                {info.map((note) => (
                  <li key={note.id}>{note.text}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
