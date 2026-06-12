import { Fragment } from 'react'
import type { CSSProperties } from 'react'
import { Clock, Play, RotateCcw, Trash2, Cpu } from 'lucide-react'
import { motion } from 'framer-motion'
import GlassCard from '../../components/GlassCard'
import StatusBadge from '../../components/StatusBadge'
import { timeAgo } from '../../lib/hooks'
import { normalizeCronStatus } from '../../lib/status'
import {
  calcSuccessRate,
  getCronScheduler,
  getCronSchedulerColor,
  getCronSchedulerLabel,
  normalizeCronModelValue,
  rowStaggerDelay,
} from './lib'
import type { CronJob, CronOverlapMarker, ModelOption } from './types'
import SchedulerBadge from './SchedulerBadge'
import SuccessBar from './SuccessBar'
import ToggleSwitch from './ToggleSwitch'
import styles from './JobCardList.module.css'

interface JobCardListProps {
  jobs: CronJob[]
  overlapMarkers: Map<string, CronOverlapMarker>
  modelOptions: ModelOption[]
  displayModel: (model?: string) => string
  pendingAction: string | null
  onToggle: (job: CronJob) => void
  onRun: (job: CronJob) => void
  onDelete: (job: CronJob) => void
  onModelChange: (job: CronJob, model: string) => void
}

export default function JobCardList({
  jobs,
  overlapMarkers,
  modelOptions,
  displayModel,
  pendingAction,
  onToggle,
  onRun,
  onDelete,
  onModelChange,
}: JobCardListProps) {
  return (
    <div className={styles.cardList}>
      {jobs.map((job, i) => {
        const overlapMarker = overlapMarkers.get(job.id)
        const showGroupHeader = i === 0 || getCronScheduler(jobs[i - 1]) !== getCronScheduler(job)
        const sr = calcSuccessRate(job.history)
        return (
          <Fragment key={job.id}>
            {showGroupHeader ? (
              <div
                className={i === 0 ? `${styles.groupHeader} ${styles.groupHeaderFirst}` : styles.groupHeader}
                style={{ '--scheduler-color': getCronSchedulerColor(job) } as CSSProperties}
              >
                {getCronSchedulerLabel(job)}
                <span className={styles.groupHeaderCount}>{jobs.filter((candidate) => getCronScheduler(candidate) === getCronScheduler(job)).length} jobs</span>
              </div>
            ) : null}
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: rowStaggerDelay(i, 0.1, 0.03) }}
            >
              <GlassCard delay={0} noPad>
                <div className={styles.cardPad}>
                  {overlapMarker ? (
                    <div className={styles.overlapPill}>
                      <Clock size={11} />
                      {overlapMarker.label}
                    </div>
                  ) : null}
                  {/* Top: name + toggle */}
                  <div className={styles.cardTopRow}>
                    <div className={styles.cardNameWrap}>
                      <p className={styles.cardName}>{job.name}</p>
                      <div className={styles.cardSchedulerBadge}><SchedulerBadge job={job} /></div>
                    </div>
                    <ToggleSwitch
                      enabled={job.enabled}
                      onChange={() => onToggle(job)}
                      disabled={job.actions?.toggle === false}
                    />
                  </div>

                  {/* Schedule */}
                  <code className={styles.scheduleCode}>
                    {job.schedule}
                  </code>

                  {/* Status */}
                  <div className={styles.cardSection}>
                    <StatusBadge status={normalizeCronStatus(job.status, job.enabled)} label={job.enabled ? job.status : 'disabled'} />
                  </div>

                  {/* Success Rate */}
                  {sr ? (
                    <div className={styles.cardSection}>
                      <p className={styles.cardMiniLabel}>Success Rate</p>
                      <SuccessBar rate={sr} />
                    </div>
                  ) : null}

                  {/* Details grid */}
                  <div className={styles.cardDetailsGrid}>
                    <div>
                      <p className={styles.cardDetailLabel}>Last Run</p>
                      <p className={styles.cardDetailValue}>{job.lastRun ? timeAgo(job.lastRun) : '—'}</p>
                    </div>
                    <div>
                      <p className={styles.cardDetailLabel}>Next Run</p>
                      <p className={styles.cardDetailValue}>{job.nextRun ? timeAgo(job.nextRun) : '—'}</p>
                    </div>
                  </div>

                  <div className={styles.cardModelRow}>
                    <p className={styles.cardDetailLabel}>Model</p>
                    <div className={styles.cardModelInner}>
                      <Cpu size={12} color='#8e8e93' />
                      {job.payload === 'agentTurn' ? (
                        <select
                          value={normalizeCronModelValue(job.model) || ''}
                          onChange={(e) => onModelChange(job, e.target.value)}
                          disabled={pendingAction === `model-${job.id}` || job.actions?.model === false}
                          aria-label={`Change model for ${job.name}`}
                          title={`Change model: ${displayModel(job.model)}`}
                          className={styles.modelSelect}
                        >
                          {modelOptions.map((option) => (
                            <option key={option.value || 'default'} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={styles.modelText}>{job.model || 'session default'}</span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className={styles.cardActions}>
                    <button
                      onClick={() => onRun(job)}
                      disabled={pendingAction === `run-${job.id}` || job.actions?.run === false}
                      className={styles.runBtn}
                    >
                      {pendingAction === `run-${job.id}` ? (
                        <RotateCcw size={12} className={styles.spinIcon} />
                      ) : (
                        <Play size={12} />
                      )}
                      Run Now
                    </button>
                    <button
                      onClick={() => onDelete(job)}
                      disabled={pendingAction === `delete-${job.id}` || job.actions?.delete === false}
                      className={styles.deleteBtn}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </GlassCard>
            </motion.div>
          </Fragment>
        )
      })}
    </div>
  )
}
