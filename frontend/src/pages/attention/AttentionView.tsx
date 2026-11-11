import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import {
  Button,
  DataTable,
  EmptyState,
  FilterChips,
  Mono,
  Notice,
  Panel,
  Select,
  Stat,
  StatRow,
  StatePill,
  TimeAgo,
} from '../../components/ui'
import type { DataTableColumn } from '../../components/ui'
import { useNow } from '../../lib/useNow'
import {
  buildAttentionRows,
  buildProjectRows,
  confirmationKindLabel,
  deadlineTiming,
  errorText,
  filterRows,
  findingAge,
  isRestricted,
  severityLabel,
  severityState,
  summarize,
} from './lib'
import type { ApiMeta, AttentionFilter, AttentionRow, LoopsData, OpenProject, ProjectRow } from './types'
import ProjectDrawer from './ProjectDrawer'
import styles from './AttentionView.module.css'

interface AttentionViewProps {
  data: LoopsData
  meta: ApiMeta
  /** Set when the latest refresh failed but an earlier reading is still shown. */
  refreshError: string | null
  onRetry: () => void
}

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'pending', label: 'Pending confirmation' },
  { value: 'findings', label: 'Findings' },
]

const cell = (value: number | null) => (value === null ? '—' : value)

export default function AttentionView({ data, meta, refreshError, onRetry }: AttentionViewProps) {
  const now = useNow()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<AttentionFilter>('all')
  const [project, setProject] = useState('all')

  const summary = useMemo(() => summarize(data), [data])
  const allRows = useMemo(() => buildAttentionRows(data, now), [data, now])
  const rows = useMemo(() => filterRows(allRows, filter, project), [allRows, filter, project])
  const projectRows = useMemo(() => buildProjectRows(data.projects, now), [data.projects, now])

  const projectOptions = useMemo(
    () => [
      { value: 'all', label: 'All projects' },
      ...[...data.projects]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => ({ value: p.id, label: isRestricted(p) ? `${p.id} (restricted)` : p.id })),
    ],
    [data.projects],
  )
  // A project that vanished from the reading must not leave the list filtered to nothing.
  const activeProject = projectOptions.some((option) => option.value === project) ? project : 'all'

  // ---- drawer (?project=<id>) ----

  const projectParam = params.get('project')
  const selected = useMemo<OpenProject | null>(() => {
    const found = projectParam ? data.projects.find((p) => p.id === projectParam) : undefined
    return found && !isRestricted(found) ? found : null
  }, [projectParam, data.projects])

  const openProject = (id: string) => {
    const target = data.projects.find((p) => p.id === id)
    if (!target || isRestricted(target)) return
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('project', id)
        return next
      },
      { replace: true },
    )
  }
  const closeProject = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('project')
        return next
      },
      { replace: true },
    )

  // ---- attention table ----

  const attentionColumns: DataTableColumn<AttentionRow>[] = [
    {
      key: 'severity',
      header: 'Severity',
      width: '128px',
      cell: (row) => {
        if (row.type === 'confirmation') {
          return row.overdue ? (
            <StatePill state="critical" label="Overdue" />
          ) : (
            <StatePill state="inactive" label="Pending" />
          )
        }
        return <StatePill state={severityState(row.severity)} label={severityLabel(row.severity)} />
      },
    },
    {
      key: 'project',
      header: 'Project',
      cell: (row) => (
        <div className={styles.projectCell}>
          <span className={styles.projectName}>{row.project}</span>
          {row.type === 'restricted' && <span className={styles.restricted}>restricted</span>}
        </div>
      ),
    },
    {
      key: 'what',
      header: 'What',
      cell: (row) => <WhatCell row={row} />,
    },
    {
      key: 'when',
      header: 'Age / deadline',
      cell: (row) => {
        if (row.type === 'finding') return <span className={styles.time}>{findingAge(row.at, now)}</span>
        if (row.type === 'confirmation') {
          const timing = deadlineTiming(row.deadline, row.overdue, now)
          return (
            <span className={timing.kind === 'overdue' ? styles.overdue : styles.time} title={row.deadline ?? undefined}>
              {timing.text}
            </span>
          )
        }
        return <span className={styles.time}>—</span>
      },
    },
    {
      key: 'code',
      header: 'Code',
      cell: (row) => {
        if (row.type === 'finding') return <Mono>{row.code}</Mono>
        if (row.type === 'confirmation') return <span className={styles.muted}>{confirmationKindLabel(row.kind)}</span>
        return <span className={styles.muted}>—</span>
      },
    },
  ]

  // ---- projects table ----

  const projectColumns: DataTableColumn<ProjectRow>[] = [
    {
      key: 'project',
      header: 'Project',
      cell: (row) => (
        <div className={styles.projectCell}>
          <span className={styles.projectName}>{row.id}</span>
          {row.restricted && <span className={styles.restricted}>restricted</span>}
        </div>
      ),
    },
    { key: 'findings', header: 'Open findings', align: 'end', mono: true, cell: (row) => row.openFindings },
    { key: 'pending', header: 'Pending', align: 'end', mono: true, cell: (row) => cell(row.pendingConfirmations) },
    {
      key: 'overdue',
      header: 'Overdue',
      align: 'end',
      mono: true,
      cell: (row) =>
        row.overdueConfirmations !== null && row.overdueConfirmations > 0 ? (
          <span className={styles.overdue}>{row.overdueConfirmations}</span>
        ) : (
          cell(row.overdueConfirmations)
        ),
    },
    {
      key: 'participants',
      header: 'Participants alive',
      align: 'end',
      mono: true,
      cell: (row) => (row.participants ? `${row.participants.alive}/${row.participants.total}` : '—'),
    },
    {
      key: 'activity',
      header: 'Last activity',
      align: 'end',
      cell: (row) => <TimeAgo className={styles.time} value={row.lastActivityAt} />,
    },
  ]

  const filtered = filter !== 'all' || activeProject !== 'all'
  const overdueCount = summary.overdueConfirmations

  return (
    <div className={styles.view}>
      {refreshError && (
        <Notice
          tone="warning"
          action={
            <Button size="sm" variant="ghost" onClick={onRetry}>
              Retry
            </Button>
          }
        >
          The latest refresh failed ({refreshError}). Showing the earlier reading.
        </Notice>
      )}
      {meta.stale && (
        <Notice tone="warning">
          Showing the last good reading of the manager loops
          {errorText(meta.error) ? `; the latest read failed: ${errorText(meta.error)}` : '; the latest read did not finish'}.
        </Notice>
      )}

      <StatRow aria-label="Attention summary">
        <Stat
          label="Projects with open items"
          value={summary.projectsWithOpenItems}
          hint={summary.projects !== null ? `of ${summary.projects}` : undefined}
        />
        <Stat label="Open findings" value={summary.openFindings} />
        <Stat
          label="Pending confirmations"
          value={summary.pendingConfirmations}
          hint={
            summary.unreadProjects > 0
              ? `${summary.unreadProjects} ${summary.unreadProjects === 1 ? 'project' : 'projects'} not read`
              : undefined
          }
        />
        <Stat
          label="Overdue confirmations"
          value={overdueCount}
          state={overdueCount !== null && overdueCount > 0 ? 'critical' : undefined}
        />
      </StatRow>

      <div className={styles.toolbar}>
        <FilterChips
          ariaLabel="Filter the attention list"
          options={FILTER_OPTIONS}
          value={filter}
          onChange={(value) => setFilter(value as AttentionFilter)}
        />
        <div className={styles.toolbarEnd}>
          {filtered && (
            <span className={styles.count} aria-live="polite">
              Showing {rows.length} of {allRows.length}
            </span>
          )}
          <Select
            className={styles.select}
            aria-label="Project"
            value={activeProject}
            onChange={(event) => setProject(event.target.value)}
            options={projectOptions}
          />
        </div>
      </div>

      <Panel
        title="Needs you"
        description="Errors and overdue confirmations first, then whatever has waited longest."
        padding="none"
      >
        <DataTable
          caption="Items that need attention"
          columns={attentionColumns}
          rows={rows}
          rowKey={(row) => row.key}
          onRowClick={(row) => openProject(row.project)}
          maxHeight="560px"
          empty={
            <EmptyState
              icon={<CheckCircle2 size={20} />}
              title={allRows.length === 0 ? 'Nothing is waiting for you' : 'Nothing matches'}
              description={
                allRows.length === 0
                  ? 'No open findings or pending confirmations in any manager loop.'
                  : 'No items match the current filter and project.'
              }
              action={
                allRows.length > 0 ? (
                  <Button
                    onClick={() => {
                      setFilter('all')
                      setProject('all')
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </Panel>

      <Panel title="Projects" padding="none">
        <DataTable
          caption="Manager loop projects"
          columns={projectColumns}
          rows={projectRows}
          rowKey={(row) => row.id}
          onRowClick={(row) => openProject(row.id)}
          selectedKey={selected?.id ?? null}
          maxHeight="none"
          empty={<EmptyState title="No manager loops" description="The ledger lists no projects." />}
        />
      </Panel>

      <ProjectDrawer project={selected} onClose={closeProject} now={now} />
    </div>
  )
}

function WhatCell({ row }: { row: AttentionRow }) {
  if (row.type === 'finding') {
    const primary = row.detail || row.subject || row.code
    return (
      <div className={styles.what}>
        <span className={styles.clamp} title={primary}>
          {primary}
        </span>
        {row.detail && row.subject && (
          <span className={styles.sub}>
            <Mono muted>{row.subject}</Mono>
            {row.count !== null && row.count > 1 && <Mono muted> ×{row.count}</Mono>}
          </span>
        )}
      </div>
    )
  }
  if (row.type === 'confirmation') {
    const primary = row.unit || row.id || 'Unnamed confirmation'
    return (
      <div className={styles.what}>
        <span className={styles.clamp} title={primary}>
          {primary}
        </span>
        {row.id && row.unit && (
          <span className={styles.sub}>
            <Mono muted>{row.id}</Mono>
          </span>
        )}
      </div>
    )
  }
  const parts = [
    `${row.openFindings} open ${row.openFindings === 1 ? 'finding' : 'findings'}`,
    `${row.pendingConfirmations} pending`,
    `${row.overdueConfirmations} overdue`,
  ]
  return (
    <div className={styles.what}>
      <span>Details are restricted</span>
      <span className={styles.sub}>{parts.join(' · ')}</span>
    </div>
  )
}
