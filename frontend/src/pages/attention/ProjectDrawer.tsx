import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Drawer, ErrorState, Mono, Notice, Skeleton, StateDot, StatePill, TimeAgo } from '../../components/ui'
import { apiQueryOptions } from '../../lib/hooks'
import {
  confirmationKindLabel,
  deadlineTiming,
  errorText,
  findingAge,
  findingLabelOrNull,
  groupFindingsByCode,
  isOverdue,
  severityLabel,
  severityState,
  shortenHomePaths,
  sortConfirmations,
  splitCommand,
} from './lib'
import type { Envelope, OpenProject, ProjectDetail } from './types'
import styles from './ProjectDrawer.module.css'

const POLL_MS = 30_000

interface ProjectDrawerProps {
  /** The project from the list reading; null while the drawer is closed. */
  project: OpenProject | null
  onClose: () => void
  now: number
}

export default function ProjectDrawer({ project, onClose, now }: ProjectDrawerProps) {
  const id = project?.id ?? null
  const detailQuery = useQuery({
    ...apiQueryOptions<Envelope<ProjectDetail>>(`/api/loops/${encodeURIComponent(id ?? '_')}`, POLL_MS),
    enabled: id !== null,
  })
  const envelope = detailQuery.data ?? null
  const detail = envelope?.data && !envelope.data.restricted ? envelope.data : null

  // The detail reading is fresher than the list one when it is there.
  const source = detail ?? project
  const confirmations = useMemo(
    () => (source && Array.isArray(source.pendingConfirmations) ? sortConfirmations(source.pendingConfirmations) : null),
    [source],
  )
  const groups = useMemo(() => (detail ? groupFindingsByCode(detail.findings ?? []) : []), [detail])

  if (!project || !source) return null

  const failedParts = (source.errors ?? []).map((part) => part.part)
  const detailError = detailQuery.error ? detailQuery.error.message : errorText(envelope?.meta.error)

  return (
    <Drawer open onClose={onClose} title={source.title || source.id} description={source.outcome || undefined} size="lg">
      <div className={styles.body}>
        {failedParts.length > 0 && (
          <Notice tone="warning">Some readings for this project failed: {failedParts.join(', ')}.</Notice>
        )}
        {envelope?.meta.stale && <Notice tone="warning">Showing the last good reading of this project.</Notice>}

        <section className={styles.section} aria-labelledby="attention-findings">
          <h3 id="attention-findings" className={styles.heading}>
            Open findings
          </h3>
          {detailQuery.isLoading ? (
            <Skeleton lines={4} label="Loading findings" />
          ) : !detail ? (
            <ErrorState
              title="Findings could not be read"
              message={detailError ?? undefined}
              onRetry={() => void detailQuery.refetch()}
            />
          ) : groups.length === 0 ? (
            <p className={styles.muted}>No open findings.</p>
          ) : (
            groups.map((group) => (
              <div key={group.code} className={styles.group}>
                <div className={styles.groupHead}>
                  <span className={styles.groupName}>
                    {findingLabelOrNull(group.code) && <span className={styles.groupLabel}>{findingLabelOrNull(group.code)}</span>}
                    <Mono muted={findingLabelOrNull(group.code) !== null} className={styles.code}>
                      {group.code}
                    </Mono>
                  </span>
                  <StatePill state={severityState(group.severity)} label={severityLabel(group.severity)} />
                  <span className={styles.muted}>
                    {group.findings.length} {group.findings.length === 1 ? 'finding' : 'findings'}
                  </span>
                </div>
                <ul className={styles.list}>
                  {group.findings.map((finding, index) => (
                    <li key={`${finding.subject ?? ''}:${index}`} className={styles.item}>
                      <div className={styles.itemHead}>
                        <span className={styles.itemTitle}>
                          {finding.subject ? <Mono>{finding.subject}</Mono> : <span className={styles.muted}>—</span>}
                          {typeof finding.count === 'number' && finding.count > 1 && <Mono muted> ×{finding.count}</Mono>}
                        </span>
                        <span className={styles.time} title={finding.at ?? undefined}>
                          {findingAge(finding.at, now)}
                        </span>
                      </div>
                      <TextWithCommand text={finding.detail} />
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>


        <section className={styles.section} aria-labelledby="attention-confirmations">
          <h3 id="attention-confirmations" className={styles.heading}>
            Pending confirmations
          </h3>
          {confirmations === null ? (
            <p className={styles.muted}>Confirmations could not be read.</p>
          ) : confirmations.length === 0 ? (
            <p className={styles.muted}>None pending.</p>
          ) : (
            <ul className={styles.list}>
              {confirmations.map((item, index) => {
                const timing = deadlineTiming(item.deadline, isOverdue(item, now), now)
                return (
                  <li key={item.id ?? index} className={styles.item}>
                    <div className={styles.itemHead}>
                      <span className={styles.itemTitle}>{item.unit || item.id || 'Unnamed confirmation'}</span>
                      <span
                        className={timing.kind === 'overdue' ? styles.overdue : styles.time}
                        title={item.deadline ?? undefined}
                      >
                        {timing.text}
                      </span>
                    </div>
                    <div className={styles.itemMeta}>
                      {item.id && <Mono muted>{item.id}</Mono>}
                      <span className={styles.muted}>{confirmationKindLabel(item.kind)}</span>
                    </div>
                    <TextWithCommand text={item.verification} />
                  </li>
                )
              })}
            </ul>
          )}
        </section>


        <section className={styles.section} aria-labelledby="attention-participants">
          <h3 id="attention-participants" className={styles.heading}>
            Participants
          </h3>
          {source.participants === null ? (
            <p className={styles.muted}>Participants could not be read.</p>
          ) : source.participants.length === 0 ? (
            <p className={styles.muted}>No participants are bound.</p>
          ) : (
            <ul className={styles.list}>
              {source.participants.map((participant) => (
                <li key={participant.name} className={styles.participant}>
                  <Mono>{participant.name}</Mono>
                  <span className={styles.muted}>
                    {[participant.role, participant.host].filter(Boolean).join(' · ') || '—'}
                  </span>
                  <span className={styles.alive}>
                    {participant.alive ? (
                      <>
                        <StateDot state="healthy" />
                        <span className={styles.muted}>Alive</span>
                      </>
                    ) : (
                      <StatePill state="warning" label="Not alive" />
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.meta}>
            Last activity <TimeAgo value={source.lastActivityAt} />
          </p>
        </section>


        <section className={styles.section} aria-labelledby="attention-status">
          <h3 id="attention-status" className={styles.heading}>
            Status text
          </h3>
          <p className={styles.meta}>As written in the project status page.</p>
          {detailQuery.isLoading ? (
            <Skeleton lines={6} label="Loading status text" />
          ) : detail?.statusMarkdown ? (
            <pre className={styles.status}>{shortenHomePaths(detail.statusMarkdown)}</pre>
          ) : (
            <p className={styles.muted}>
              {detail ? 'No status text is published for this project.' : 'Status text could not be read.'}
            </p>
          )}
        </section>
      </div>
    </Drawer>
  )
}

/**
 * Ledger text as a plain sentence, with any command it carries in its own code block under it
 * (never inline in the sentence).
 */
function TextWithCommand({ text }: { text: string | null | undefined }) {
  if (!text) return null
  const parts = splitCommand(text)
  return (
    <>
      {parts.summary && <p className={styles.detail}>{parts.summary}</p>}
      {parts.command && (
        <pre className={styles.command}>
          <code>{parts.command}</code>
        </pre>
      )}
    </>
  )
}
