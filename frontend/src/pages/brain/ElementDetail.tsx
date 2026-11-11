import { Drawer, Mono, StatePill, TimeAgo } from '../../components/ui'
import { ActionList } from './ActionList'
import type { ElementDetail as Detail } from './lib'
import styles from './ElementDetail.module.css'
import type { OperationCapability } from './types'

export function ElementDrawer({
  detail,
  capabilities,
  running,
  onClose,
  onRun,
}: {
  detail: Detail | null
  capabilities: OperationCapability[] | null
  running: string | null
  onClose: () => void
  onRun: (action: OperationCapability) => void
}) {
  const offered =
    detail && capabilities
      ? detail.actionIds.flatMap((id) => {
          const found = capabilities.find((capability) => capability.id === id && capability.safetyClass !== 'W2')
          return found ? [found] : []
        })
      : []
  const checks = offered.filter((action) => action.safetyClass === 'R0')
  const changes = offered.filter((action) => action.safetyClass === 'W1')

  return (
    <Drawer
      open={detail !== null}
      onClose={onClose}
      title={detail?.title ?? ''}
      description={
        detail && (
          <span className={styles.lead}>
            {/* A fact such as "Set up" is not a state: plain text, no pill. */}
            {detail.stateWord ? <span>{detail.stateWord}</span> : <StatePill state={detail.state} />}
            <span>
              last read <TimeAgo value={detail.observedAt} fallback="not read" />
            </span>
          </span>
        )
      }
    >
      {detail && (
        <div className={styles.body}>
          {detail.rows.length > 0 && (
            <dl className={styles.rows}>
              {detail.rows.map((row) => (
                <div key={row.label} className={styles.row} data-state={row.state}>
                  <dt>{row.label}</dt>
                  <dd>
                    {row.valueAt !== undefined ? (
                      <TimeAgo value={row.valueAt} fallback="not read" />
                    ) : row.mono ? (
                      <Mono>{row.value}</Mono>
                    ) : (
                      row.value
                    )}
                    {row.observedAt !== undefined && row.valueAt === undefined && (
                      <span className={styles.observed}>
                        <TimeAgo value={row.observedAt} fallback="not read" />
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {detail.items.length > 0 && (
            <section aria-labelledby="detail-items">
              <h3 id="detail-items" className={styles.heading}>
                Sources
              </h3>
              <ul className={styles.items}>
                {detail.items.map((item) => (
                  <li key={item.id} className={styles.item} data-state={item.state}>
                    <span className={styles.itemName}>
                      <Mono truncate>{item.label}</Mono>
                    </span>
                    <span className={styles.itemState}>
                      <StatePill state={item.state} label={item.word} />
                    </span>
                    <span className={styles.itemMeta}>
                      synced <TimeAgo value={item.lastSyncAt} fallback="never read" />
                      {item.note ? ` · ${item.note}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail.notes.length > 0 && (
            <section aria-labelledby="detail-notes">
              <h3 id="detail-notes" className={styles.heading}>
                Notes
              </h3>
              <ul className={styles.notes}>
                {detail.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>
          )}

          {detail.actionIds.length > 0 && (
            <section aria-labelledby="detail-actions" className={styles.actions}>
              <h3 id="detail-actions" className={styles.heading}>
                Maintenance
              </h3>
              {capabilities === null ? (
                <p className={styles.muted}>Maintenance actions could not be read.</p>
              ) : offered.length === 0 ? (
                <p className={styles.muted}>No maintenance action is available for this.</p>
              ) : (
                <>
                  {checks.length > 0 && (
                    <div>
                      <h4 className={styles.subheading}>Check</h4>
                      <ActionList actions={checks} running={running} onRun={onRun} />
                    </div>
                  )}
                  {changes.length > 0 && (
                    <div>
                      <h4 className={styles.subheading}>Change (asks first)</h4>
                      <ActionList actions={changes} running={running} onRun={onRun} />
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      )}
    </Drawer>
  )
}
