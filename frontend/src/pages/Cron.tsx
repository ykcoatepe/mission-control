import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Clock, AlertTriangle, CheckCircle2, Plus, XCircle } from 'lucide-react'
import { AnimatePresence } from 'framer-motion'
import PageTransition from '../components/PageTransition'
import { useIsMobile } from '../lib/useIsMobile'
import GlassCard from '../components/GlassCard'
import PageHeader from '../components/ui/PageHeader'
import EmptyState from '../components/ui/EmptyState'
import { useApi } from '../lib/hooks'
import { normalizeCronStatus } from '../lib/status'
import {
  buildCronModelOptions,
  buildCronOverlapMarkers,
  cronFetch,
  errorMessage,
  getCronScheduler,
  getCronSchedulerLabel,
  normalizeCronModelValue,
} from './cron/lib'
import type {
  CreateCronJobPayload,
  CronApiResponse,
  CronJob,
  CronModelResponse,
  CronScheduler,
  CronStatusFilter,
} from './cron/types'
import SummaryCards from './cron/SummaryCards'
import CreateJobModal from './cron/CreateJobModal'
import ConfirmDialog from './cron/ConfirmDialog'
import JobsTable from './cron/JobsTable'
import JobCardList from './cron/JobCardList'
import styles from './Cron.module.css'

interface Toast {
  kind: 'ok' | 'error'
  text: string
}

export default function Cron() {
  const m = useIsMobile()
  const { data, loading, error, refetch } = useApi<CronApiResponse>('/api/cron', 30000)
  const { data: modelsData } = useApi<CronModelResponse[]>('/api/models', 60000)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CronJob | null>(null)
  const [jobSearch, setJobSearch] = useState('')
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<CronStatusFilter>('all')
  const [schedulerFilter, setSchedulerFilter] = useState<'all' | CronScheduler>('all')
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [])

  const showToast = (kind: Toast['kind'], text: string) => {
    setToast({ kind, text })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), kind === 'ok' ? 4000 : 5000)
  }

  const jobs = useMemo<CronJob[]>(() => data?.jobs || [], [data?.jobs])
  const modelOptions = useMemo(
    () => buildCronModelOptions(Array.isArray(modelsData) ? modelsData : [], jobs),
    [modelsData, jobs]
  )
  const modelLabelByValue = useMemo(
    () => new Map(modelOptions.map((option) => [option.value, option.label])),
    [modelOptions]
  )
  const displayModel = (model?: string) => {
    const normalized = normalizeCronModelValue(model) || ''
    return modelLabelByValue.get(normalized) || normalized || 'Default'
  }
  const overlapState = useMemo(() => buildCronOverlapMarkers(jobs), [jobs])

  const statusCounts = useMemo(() => {
    const counts: Record<CronStatusFilter, number> = {
      all: jobs.length,
      active: 0,
      disabled: 0,
      failed: 0,
      overlap: overlapState.affectedJobs,
    }
    for (const job of jobs) {
      const status = normalizeCronStatus(job.status, job.enabled)
      if (status === 'active' || status === 'disabled' || status === 'failed') counts[status]++
    }
    return counts
  }, [jobs, overlapState])

  const schedulerCounts = useMemo(() => ({
    all: jobs.length,
    openclaw: jobs.filter((job) => getCronScheduler(job) === 'openclaw').length,
    hermes: jobs.filter((job) => getCronScheduler(job) === 'hermes').length,
  }), [jobs])

  const filteredJobs = useMemo(() => {
    const query = jobSearch.trim().toLowerCase()
    let result = jobs
    if (schedulerFilter !== 'all') result = result.filter((job) => getCronScheduler(job) === schedulerFilter)
    if (query) {
      result = result.filter((job) => [
        job.name,
        job.id,
        job.sourceId,
        job.description,
        getCronSchedulerLabel(job),
      ].some((value) => String(value || '').toLowerCase().includes(query)))
    }
    if (statusFilter === 'overlap') {
      result = result.filter((job) => overlapState.markers.has(job.id))
    } else if (statusFilter !== 'all') {
      result = result.filter((job) => normalizeCronStatus(job.status, job.enabled) === statusFilter)
    }
    return [...result].sort((left, right) => {
      const order = { openclaw: 0, hermes: 1 } as const
      const schedulerOrder = order[getCronScheduler(left)] - order[getCronScheduler(right)]
      if (schedulerOrder !== 0) return schedulerOrder
      return String(left.name || '').localeCompare(String(right.name || ''))
    })
  }, [jobs, jobSearch, overlapState, schedulerFilter, statusFilter])

  const hasActiveFilters = statusFilter !== 'all' || schedulerFilter !== 'all' || jobSearch.trim() !== ''

  const clearFilters = () => {
    setStatusFilter('all')
    setSchedulerFilter('all')
    setJobSearch('')
  }

  const handleSummaryFilterClick = (filterKey: CronStatusFilter) => {
    setStatusFilter((current) => current === filterKey ? 'all' : filterKey)
  }

  // ---- write mutations ----

  const toggleMutation = useMutation({
    mutationFn: (job: CronJob) =>
      cronFetch(`/api/cron/${job.id}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ enabled: !job.enabled, scheduler: getCronScheduler(job) }),
      }),
  })

  const runMutation = useMutation({
    mutationFn: (job: CronJob) =>
      cronFetch(`/api/cron/${job.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ scheduler: getCronScheduler(job) }),
      }),
  })

  const deleteMutation = useMutation({
    mutationFn: (job: CronJob) =>
      cronFetch(`/api/cron/${job.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ scheduler: getCronScheduler(job) }),
      }),
  })

  const createMutation = useMutation({
    mutationFn: (job: CreateCronJobPayload) =>
      cronFetch('/api/cron/create', {
        method: 'POST',
        body: JSON.stringify({ job }),
      }),
  })

  const modelMutation = useMutation({
    mutationFn: ({ job, model }: { job: CronJob; model: string }) =>
      cronFetch(`/api/cron/${job.id}/model`, {
        method: 'PATCH',
        body: JSON.stringify({ model, scheduler: getCronScheduler(job) }),
      }),
  })

  const handleToggle = async (job: CronJob) => {
    if (job.actions?.toggle === false) return
    setPendingAction(`toggle-${job.id}`)
    try {
      await toggleMutation.mutateAsync(job)
      refetch()
    } catch (err) {
      showToast('error', `Failed to toggle "${job.name}": ${errorMessage(err)}`)
    } finally {
      setPendingAction(null)
    }
  }

  const handleRun = async (job: CronJob) => {
    if (job.actions?.run === false) return
    setPendingAction(`run-${job.id}`)
    try {
      await runMutation.mutateAsync(job)
      showToast('ok', `"${job.name}" triggered!`)
      setTimeout(refetch, 1500)
    } catch (err) {
      showToast('error', `Run failed: ${errorMessage(err)}`)
    } finally {
      setPendingAction(null)
    }
  }

  const requestDelete = (job: CronJob) => {
    if (job.actions?.delete === false) return
    setDeleteTarget(job)
  }

  const confirmDelete = async () => {
    const job = deleteTarget
    if (!job) return
    setPendingAction(`delete-${job.id}`)
    try {
      await deleteMutation.mutateAsync(job)
      showToast('ok', `"${job.name}" deleted`)
      refetch()
    } catch (err) {
      showToast('error', `Delete failed: ${errorMessage(err)}`)
    } finally {
      setDeleteTarget(null)
      setPendingAction(null)
    }
  }

  const handleCreateJob = async (job: CreateCronJobPayload) => {
    try {
      await createMutation.mutateAsync(job)
      showToast('ok', `"${job.name}" created`)
      refetch()
    } catch (err) {
      showToast('error', `Create failed: ${errorMessage(err)}`)
    }
  }

  const handleModelChange = async (job: CronJob, model: string) => {
    if (job.actions?.model === false) return
    setPendingAction(`model-${job.id}`)
    try {
      await modelMutation.mutateAsync({ job, model })
      showToast('ok', `"${job.name}" model set to ${model || 'default'}`)
      refetch()
    } catch (err) {
      showToast('error', `Model update failed: ${errorMessage(err)}`)
    } finally {
      setPendingAction(null)
    }
  }

  if (loading && !data) {
    return (
      <PageTransition>
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} />
        </div>
      </PageTransition>
    )
  }

  if (error && !data) {
    return (
      <PageTransition>
        <div className={styles.errorWrap}>
          <GlassCard noPad>
            <div className={m ? `${styles.errorPad} ${styles.errorPadMobile}` : styles.errorPad}>
              <div className={styles.errorTitle}>
                <AlertTriangle size={18} />
                <strong>Cron API unavailable</strong>
              </div>
              <div className={styles.errorMessage}>{error}</div>
              <div>
                <button
                  onClick={refetch}
                  className={styles.retryBtn}
                >
                  Retry
                </button>
              </div>
            </div>
          </GlassCard>
        </div>
      </PageTransition>
    )
  }

  return (
    <>
      <PageTransition>
        <div className={m ? `${styles.page} ${styles.pageMobile}` : styles.page}>
          {/* Header */}
          <div className={styles.headerRow}>
            <PageHeader
              icon={<Clock size={m ? 18 : 22} className={styles.iconBlue} />}
              title="Cron Jobs"
              subtitle="Scheduled jobs that run automatically"
            />
            <button
              onClick={() => setShowCreateModal(true)}
              className={m ? `${styles.createBtn} ${styles.createBtnMobile}` : styles.createBtn}
            >
              <Plus size={m ? 14 : 16} />
              Create Job
            </button>
          </div>

          {/* Toast notification */}
          {toast && (
            <div className={`${styles.toast} ${toast.kind === 'ok' ? styles.toastOk : styles.toastError}`}>
              {toast.kind === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              {toast.text}
            </div>
          )}

          {/* Summary cards double as the status filter */}
          <SummaryCards
            m={m}
            counts={statusCounts}
            statusFilter={statusFilter}
            onSelect={handleSummaryFilterClick}
          />

          <div className={styles.schedulerBar}>
            {([
              { key: 'all', label: 'All schedulers', count: schedulerCounts.all, color: 'rgba(255,255,255,0.62)' },
              { key: 'openclaw', label: 'OpenClaw', count: schedulerCounts.openclaw, color: '#BF5AF2' },
              { key: 'hermes', label: 'Hermes', count: schedulerCounts.hermes, color: '#64D2FF' },
            ] as const).map((item) => (
              <button
                key={item.key}
                onClick={() => setSchedulerFilter(item.key)}
                className={[
                  m ? `${styles.schedulerPill} ${styles.schedulerPillMobile}` : styles.schedulerPill,
                  schedulerFilter === item.key ? styles.schedulerPillActive : '',
                ].join(' ')}
                style={{ '--pill-color': item.color } as CSSProperties}
              >
                {item.label}
                <span className={schedulerFilter === item.key ? `${styles.schedulerPillCount} ${styles.schedulerPillCountActive}` : styles.schedulerPillCount}>
                  {item.count}
                </span>
              </button>
            ))}
            <span className={styles.schedulerBarCount}>
              {filteredJobs.length !== jobs.length ? `Showing ${filteredJobs.length} of ${jobs.length}` : `${jobs.length} total`}
            </span>
          </div>

          <div className={styles.searchWrap}>
            <input
              type="text"
              value={jobSearch}
              onChange={(e) => setJobSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && jobSearch) {
                  e.preventDefault()
                  setJobSearch('')
                }
              }}
              placeholder="Search jobs by name, id, scheduler..."
              aria-label="Search cron jobs by name, id, or scheduler"
              className={m ? `${styles.searchInput} ${styles.searchInputMobile}` : styles.searchInput}
            />
            {jobSearch ? (
              <button
                type="button"
                onClick={() => setJobSearch('')}
                aria-label="Clear cron job search"
                title="Clear search"
                className={styles.searchClear}
              >
                <XCircle size={14} />
              </button>
            ) : null}
          </div>

          {/* Jobs — card layout on mobile, table on desktop */}
          {filteredJobs.length === 0 ? (
            <EmptyState
              icon={<Clock size={22} color="#007AFF" />}
              title={jobs.length === 0 ? 'No cron jobs yet' : 'No jobs match'}
              description={jobs.length === 0
                ? 'Create your first scheduled job with the button above.'
                : 'No jobs match the current search and filters.'}
              color="#007AFF"
              action={hasActiveFilters ? (
                <button onClick={clearFilters} className={styles.clearFiltersBtn}>
                  Clear filters
                </button>
              ) : undefined}
            />
          ) : m ? (
            <JobCardList
              jobs={filteredJobs}
              overlapMarkers={overlapState.markers}
              modelOptions={modelOptions}
              displayModel={displayModel}
              pendingAction={pendingAction}
              onToggle={handleToggle}
              onRun={handleRun}
              onDelete={requestDelete}
              onModelChange={handleModelChange}
            />
          ) : (
            <JobsTable
              jobs={filteredJobs}
              overlapMarkers={overlapState.markers}
              modelOptions={modelOptions}
              displayModel={displayModel}
              pendingAction={pendingAction}
              onToggle={handleToggle}
              onRun={handleRun}
              onDelete={requestDelete}
              onModelChange={handleModelChange}
            />
          )}
        </div>
      </PageTransition>

      {/* Modals — outside PageTransition to avoid position:fixed issues */}
      <AnimatePresence>
        {showCreateModal && (
          <CreateJobModal
            onClose={() => setShowCreateModal(false)}
            onSubmit={handleCreateJob}
            modelOptions={modelOptions}
          />
        )}
        {deleteTarget && (
          <ConfirmDialog
            title="Delete cron job?"
            message={`"${deleteTarget.name}" will be removed from ${getCronSchedulerLabel(deleteTarget)}. This cannot be undone.`}
            confirmLabel="Delete"
            busy={pendingAction === `delete-${deleteTarget.id}`}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={confirmDelete}
          />
        )}
      </AnimatePresence>
    </>
  )
}
