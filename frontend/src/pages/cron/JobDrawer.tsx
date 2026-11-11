import type { ReactNode } from 'react'
import { Play, Trash2 } from 'lucide-react'
import { Button, Drawer, Meter, Mono, Notice, Select, StatePill, Switch, TimeAgo } from '../../components/ui'
import { calcSuccessRate, getCronSchedulerLabel, normalizeCronModelValue } from './lib'
import type { CronJob, CronOverlapMarker, ModelOption } from './types'
import { jobState } from './jobState'
import { NextRun } from './NextRun'
import { scheduleDisplay } from './cronSchedule'
import { LIST_DESCRIPTION_LIMIT, describeJobText, describeRunKind, failureReason, isInternalKey } from './jobWords'
import { formatRelative, parseTime } from '../../lib/time'
import type { SchedulerReading } from './schedulerReadings'
import { useNow } from '../../lib/useNow'
import styles from './JobDrawer.module.css'

interface JobDrawerProps {
  job: CronJob | null
  open: boolean
  onClose: () => void
  overlapMarker?: CronOverlapMarker
  modelOptions: ModelOption[]
  displayModel: (model?: string) => string
  /** Set when the job's scheduler could only be read earlier; its details may have changed. */
  staleSince?: SchedulerReading | null
  pendingAction: string | null
  /** What the system said when it refused the last change to this job. */
  error?: string | null
  onToggle: (job: CronJob) => void
  onRun: (job: CronJob) => void
  onDelete: (job: CronJob) => void
  onModelChange: (job: CronJob, model: string) => void
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt className={styles.factLabel}>{label}</dt>
      <dd className={styles.factValue}>{children}</dd>
    </div>
  )
}

export default function JobDrawer({
  job,
  open,
  onClose,
  overlapMarker,
  modelOptions,
  displayModel,
  staleSince,
  pendingAction,
  error,
  onToggle,
  onRun,
  onDelete,
  onModelChange,
}: JobDrawerProps) {
  const now = useNow()
  if (!job) return null

  const state = jobState(job)
  const canToggle = job.actions?.toggle !== false
  const canRun = job.actions?.run !== false
  const canDelete = job.actions?.delete !== false
  const canChangeModel = job.payload === 'agentTurn' && job.actions?.model !== false
  const successRate = calcSuccessRate(job.history)
  const schedule = scheduleDisplay(job.schedule, job.scheduleKind)
  const runKind = describeRunKind(job.payload, job.target)
  const internalKey = isInternalKey(job.description)
  const descriptionText = describeJobText(job.description)
  const failed = state.state === 'critical'
  const reason = failed ? failureReason(job) : null
  const staleAt = staleSince ? parseTime(staleSince.observedAt) : null

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={job.name}
      description={
        <>
          {getCronSchedulerLabel(job)} · <Mono muted>{job.sourceId || job.id}</Mono>
        </>
      }
      footer={
        <div className={styles.footer}>
          {canDelete ? (
            <Button
              variant="danger"
              data-return-focus="delete"
              icon={<Trash2 size={14} />}
              loading={pendingAction === `delete-${job.id}`}
              onClick={() => onDelete(job)}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          {canRun && (
            <Button
              variant="primary"
              data-return-focus="run"
              icon={<Play size={14} />}
              loading={pendingAction === `run-${job.id}`}
              onClick={() => onRun(job)}
            >
              Run now
            </Button>
          )}
        </div>
      }
    >
      <div className={styles.body}>
        {error && (
          <Notice tone="critical" title="Not changed">
            {error}
          </Notice>
        )}
        {job.verified === false && (
          <Notice tone="warning" title="Not confirmed">
            The last change to this job was sent, but the scheduler has not confirmed it. What is shown is what it reports now.
          </Notice>
        )}
        <dl className={styles.facts}>
          <Fact label="State">
            <span className={styles.inline}>
              <StatePill state={state.state} label={state.label} />
              {canToggle && (
                <Switch
                  checked={job.enabled}
                  onChange={() => onToggle(job)}
                  disabled={pendingAction === `toggle-${job.id}`}
                  label={job.enabled ? 'Enabled' : 'Paused'}
                />
              )}
            </span>
          </Fact>
          <Fact label="Schedule">
            {schedule.raw ? <Mono>{schedule.text}</Mono> : <span className={styles.note}>{schedule.text}</span>}
          </Fact>
          <Fact label="Last run">
            <TimeAgo value={job.lastRun} />
          </Fact>
          <Fact label="Next run">
            <NextRun job={job} />
          </Fact>
          {job.pausedReason ? <Fact label="Paused because">{job.pausedReason}</Fact> : null}
          {job.duration ? (
            <Fact label="Duration">
              <Mono>{job.duration}</Mono>
            </Fact>
          ) : null}
          <Fact label="Model">
            {canChangeModel ? (
              <Select
                aria-label={`Model for ${job.name}`}
                title={displayModel(job.model)}
                value={normalizeCronModelValue(job.model) || ''}
                disabled={pendingAction === `model-${job.id}`}
                onChange={(event) => onModelChange(job, event.target.value)}
                options={modelOptions.map((option) => ({ value: option.value, label: option.label }))}
              />
            ) : job.payload === 'agentTurn' ? (
              displayModel(job.model)
            ) : (
              job.model || '—'
            )}
          </Fact>
          <Fact label="What it does">
            {runKind.text ?? (runKind.unknown ? null : '—')}
            {runKind.unknown ? (
              <>
                {runKind.text ? ' ' : null}
                <Mono muted>{runKind.unknown}</Mono>
              </>
            ) : null}
          </Fact>
          {job.thinking ? <Fact label="Thinking">{job.thinking}</Fact> : null}
          {failed ? (
            <Fact label="Why it failed">
              {reason ?? <span className={styles.note}>No reason reported</span>}
            </Fact>
          ) : null}
        </dl>

        {staleSince && (
          <Notice tone="warning" title={`${staleSince.name} could only be read earlier`}>
            This job is from the last good reading{staleAt !== null ? `, ${formatRelative(staleAt, now)}` : ''}. It may have changed since.
          </Notice>
        )}

        {overlapMarker && (
          <Notice tone="warning" title={overlapMarker.label}>
            {overlapMarker.detail}
          </Notice>
        )}

        <section className={styles.section} aria-label="Recent results">
          <h3 className={styles.sectionTitle}>Recent results</h3>
          {successRate ? (
            <>
              <Meter
                value={successRate.pct}
                label="Recent runs that succeeded"
                state={successRate.failed === 0 ? 'healthy' : successRate.pct >= 50 ? 'warning' : 'critical'}
              />
              <p className={styles.note}>
                {successRate.ok} of {successRate.total} recent runs succeeded
                {successRate.failed > 0 ? `, ${successRate.failed} failed` : ''}.
              </p>
            </>
          ) : (
            <p className={styles.note}>No run history was returned for this job.</p>
          )}
        </section>

        {job.description && internalKey && (
          <section className={styles.section} aria-label="Built-in job">
            <h3 className={styles.sectionTitle}>Built-in job</h3>
            <p className={styles.note}>
              The scheduler runs this one itself and gives it no description. Internal name: <Mono muted>{job.description.trim()}</Mono>
            </p>
          </section>
        )}

        {job.description && !internalKey && (
          <section className={styles.section} aria-label="Description">
            <h3 className={styles.sectionTitle}>Description</h3>
            <p className={styles.description}>
              {descriptionText.text}
              {descriptionText.cut ? '…' : ''}
            </p>
            {descriptionText.cut && (
              <p className={styles.note}>
                The jobs list shortens descriptions to {LIST_DESCRIPTION_LIMIT} characters. The Schedule view shows the
                full text in the notes of this job&rsquo;s entry.
              </p>
            )}
          </section>
        )}
      </div>
    </Drawer>
  )
}
