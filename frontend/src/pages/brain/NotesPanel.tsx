import { useState } from 'react'
import { Block, Button, StateMark, TimeAgo } from '../../components/ui'
import { Disclosure } from './Disclosure'
import { recoveredLines, type NoteGroups } from './lib'
import styles from './NotesPanel.module.css'
import type { IncidentBanner } from './types'

export interface RecoveredNote {
  key: string
  banner: IncidentBanner
}

/** How many recovered problems show before "Show all". */
export const RECOVERED_SHOWN = 10

/**
 * Current notes and the history of problems that recovered. Three quiet tiers, in this order: what
 * needs action (coloured by its state), problems that recovered on their own (a summary, folded),
 * and what the server marked as information (folded). History never changes the verdict and is
 * never coloured as a fault.
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
  const { action, info } = notes
  const lines = recoveredLines(recovered)
  const empty = action.length === 0 && info.length === 0 && lines.length === 0
  // Only action notes are something to do: recovered history and information are not.
  const nothingToDo = action.length === 0
  return (
    <Block
      title="Notes"
      actions={
        lines.length > 0 ? (
          <Button size="sm" onClick={onAcknowledge}>
            {lines.length === 1 ? 'Acknowledge' : `Acknowledge all ${lines.length}`}
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
                  <StateMark state={note.state} />
                  <span>{note.text}</span>
                </li>
              ))}
            </ul>
          )}
          {lines.length > 0 && <RecoveredGroup lines={lines} />}
          {info.length > 0 && (
            <Disclosure summary={`${info.length} more for information`}>
              <ul className={styles.infoList} aria-label="For information">
                {info.map((note) => (
                  <li key={note.id}>{note.text}</li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      )}
    </Block>
  )
}

function RecoveredGroup({ lines }: { lines: ReturnType<typeof recoveredLines> }) {
  const [all, setAll] = useState(false)
  const shown = all ? lines : lines.slice(0, RECOVERED_SHOWN)
  const latest = lines.find((line) => line.at !== null)?.at ?? null
  const count = lines.length
  return (
    <Disclosure
      tone="secondary"
      summary={
        <>
          {count === 1 ? '1 past problem recovered on its own' : `${count} past problems recovered on their own`}
          {latest && (
            <>
              {' · latest '}
              <TimeAgo value={latest} />
            </>
          )}
        </>
      }
    >
      <ul className={styles.recoveredList} aria-label="Recovered on their own">
        {shown.map((line) => (
          <li key={line.key}>
            <span>{line.text}</span>
            {line.at && (
              <>
                {' '}
                <TimeAgo value={line.at} className={styles.time} />
              </>
            )}
          </li>
        ))}
      </ul>
      {count > shown.length && (
        <button type="button" className={styles.more} onClick={() => setAll(true)}>
          Show all {count}
        </button>
      )}
    </Disclosure>
  )
}
