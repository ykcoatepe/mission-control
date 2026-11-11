import { Fragment, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CheckCircle2, TriangleAlert } from 'lucide-react'
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
import { breakdownWords } from '../../lib/signals'
import type { AttentionReading } from '../../lib/signals'
import { useNow } from '../../lib/useNow'
import {
  buildAttentionRows,
  buildProjectRows,
  confirmationKindLabel,
  deadlineTiming,
  errorText,
  filterChipOptions,
  filterRows,
  findingAge,
  findingLabel,
  findingLabelOrNull,
  isRestricted,
  parseAttentionFilter,
  severityLabel,
  severityState,
  summarize,
  tableSummary,
} from './lib'
import type { ApiMeta, AttentionFilter, AttentionRow, LoopsData, OpenProject, ProjectRow } from './types'
import ProjectDrawer from './ProjectDrawer'
import styles from './AttentionView.module.css'

interface AttentionViewProps {
  data: LoopsData
  meta: ApiMeta
  /**
   * The one attention number (items that need the operator), from the shell signals
   * (`GET /api/signals`): the same value as the top-bar pill and the sidebar badge.
   * null while it has not been read.
   */
  attention: AttentionReading | null
  /** Set when the latest refresh failed but an earlier reading is still shown. */
  refreshError: string | null
  onRetry: () => void
}

const cell = (value: number | null) => (value === null ? '—' : value)

export default function AttentionView({ data, meta, attention, refreshError, onRetry }: AttentionViewProps) {
  const now = useNow()
  const [params, setParams] = useSearchParams()
  // The list filters live in the URL (?filter=overdue&scope=<project>) so a view can be shared or reloaded.
  const filter = parseAttentionFilter(params.get('filter'))
  const project = params.get('scope') ?? 'all'
  const setQuery = (key: 'filter' | 'scope', value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value === 'all') next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true },
    )
  const setFilter = (value: AttentionFilter) => setQuery('filter', value)
  const setProject = (value: string) => setQuery('scope', value)

  const summary = useMemo(() => summarize(data), [data])
  const allRows = useMemo(() => buildAttentionRows(data, now), [data, now])
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
  const rows = useMemo(() => filterRows(allRows, filter, activeProject), [allRows, filter, activeProject])
  // Chip counts use the unit of the stats above (confirmations, findings), within the chosen project.
  const filterOptions = useMemo(
    () => filterChipOptions(allRows, projectRows, activeProject, filter),
    [allRows, projectRows, activeProject, filter],
  )

  // ---- drawer (?project=<id>) ----

  const projectParam = params.get('project')
  const selected = useMemo<OpenProject | null>(() => {
    const found = projectParam ? data.projects.find((p) => p.id === projectParam) : undefined
    return found && !isRestricted(found) ? found : null
  }, [projectParam, data.projects])

  // A deep link to a restricted or unknown project opens nothing; do not leave it in the address.
  const dropProjectParam = projectParam !== null && selected === null
  useEffect(() => {
    if (!dropProjectParam) return
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('project')
        return next
      },
      { replace: true },
    )
  }, [dropProjectParam, setParams])

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
      width: '208px',
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
      header: 'Type',
      cell: (row) => {
        if (row.type === 'finding') return <FindingType code={row.code} />
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
          // Never colour alone: an icon and a word for screen readers go with the number.
          <span className={styles.overdue}>
            <TriangleAlert size={12} aria-hidden="true" />
            {row.overdueConfirmations}
            <span className="visually-hidden"> overdue</span>
          </span>
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
  const attentionCount = attention?.count ?? null
  const attentionHint = attention ? breakdownWords(attention.breakdown) : null

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
          label="Need attention"
          value={attentionCount}
          state={attentionCount !== null && attentionCount > 0 ? attention?.state : undefined}
          hint={attentionHint ?? (attention === null || attention.count === null ? 'not read' : undefined)}
        />
        <Stat
          label="Projects with open items"
          value={summary.projectsWithOpenItems}
          hint={
            [
              summary.projects !== null ? `of ${summary.projects}` : null,
              summary.unreadProjects > 0 ? `${summary.unreadProjects} not read` : null,
            ]
              .filter(Boolean)
              .join(' · ') || undefined
          }
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
      </StatRow>

      <div className={styles.toolbar}>
        <FilterChips
          ariaLabel="Filter the attention list"
          options={filterOptions}
          value={filter}
          onChange={(value) => setFilter(parseAttentionFilter(value))}
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
          rowClickable={(row) => row.type !== 'restricted'}
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
                      setParams(
                        (prev) => {
                          const next = new URLSearchParams(prev)
                          next.delete('filter')
                          next.delete('scope')
                          return next
                        },
                        { replace: true },
                      )
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
          rowClickable={(row) => !row.restricted}
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
    const parts = tableSummary(row.summary)
    const primary = parts.summary || row.subject || findingLabel(row.code)
    return (
      <div className={styles.what}>
        <span className={styles.clamp} title={row.summary ?? primary}>
          {primary}
        </span>
        {parts.command && !parts.commandCut && (
          <code className={styles.command} title={parts.command}>
            {parts.command}
          </code>
        )}
        {row.summary && row.subject && (
          <span className={styles.sub}>
            <Mono muted>{row.subject}</Mono>
            {row.count !== null && row.count > 1 && <Mono muted> ×{row.count}</Mono>}
          </span>
        )}
      </div>
    )
  }
  if (row.type === 'confirmation') {
    const parts = tableSummary(row.unit)
    const primary = parts.summary || row.id || 'Unnamed confirmation'
    return (
      <div className={styles.what}>
        <span className={styles.clamp} title={row.unit ?? primary}>
          {primary}
        </span>
        {parts.command && !parts.commandCut && (
          <code className={styles.command} title={parts.command}>
            {parts.command}
          </code>
        )}
        {row.id && row.unit && (
          <span className={styles.sub}>
            <Mono muted>{row.id}</Mono>
          </span>
        )}
      </div>
    )
  }
  const count = (value: number | null, one: string, many: string) =>
    value === null ? `${many} not read` : `${value} ${value === 1 ? one : many}`
  return (
    <div className={styles.what}>
      <span>Details are restricted</span>
      <span className={styles.sub}>
        <span className={styles.part}>{count(row.openFindings, 'open finding', 'open findings')}</span>
        {' · '}
        <span className={styles.part}>
          {row.pendingConfirmations === null ? 'pending not read' : `${row.pendingConfirmations} pending`}
        </span>
        {' · '}
        {row.overdueConfirmations !== null && row.overdueConfirmations > 0 ? (
          // Never colour alone: an icon, the number and the word go together.
          <span className={styles.overdue}>
            <TriangleAlert size={12} aria-hidden="true" />
            {row.overdueConfirmations} overdue
          </span>
        ) : (
          <span className={styles.part}>
            {row.overdueConfirmations === null ? 'overdue not read' : '0 overdue'}
          </span>
        )}
      </span>
    </div>
  )
}

/** A finding's plain-words label, with the internal code as quiet Mono text under it. */
function FindingType({ code }: { code: string }) {
  const label = findingLabelOrNull(code)
  return (
    <div className={styles.type}>
      {label && <span className={styles.typeLabel}>{label}</span>}
      <Mono muted={label !== null} className={styles.code}>
        {code.split('_').map((part, index, parts) => (
          <Fragment key={index}>
            {part}
            {index < parts.length - 1 && (
              <>
                _<wbr />
              </>
            )}
          </Fragment>
        ))}
      </Mono>
    </div>
  )
}
