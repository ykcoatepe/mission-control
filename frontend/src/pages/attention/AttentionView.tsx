import { Fragment, useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  AlarmLine,
  Block,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  FilterChips,
  Mono,
  Notice,
  Select,
  StateMark,
  StatePill,
  TimeAgo,
} from '../../components/ui'
import type { DataTableColumn } from '../../components/ui'
import { useAckActions } from '../../lib/acks'
import { attentionWords, breakdownWords } from '../../lib/signals'
import type { AttentionReading } from '../../lib/signals'
import { useNow } from '../../lib/useNow'
import AckControls, { AckError } from './AckControls'
import {
  ackStatus,
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
  groupRows,
  isRestricted,
  parseAttentionFilter,
  restrictedSummary,
  rowScope,
  rowSentence,
  rowState,
  rowTitle,
  rowWord,
  tableSummary,
  worstRow,
} from './lib'
import type { ApiMeta, AttentionFilter, AttentionRow, LoopsData, OpenProject, ProjectRow } from './types'
import ProjectDrawer from './ProjectDrawer'
import styles from './AttentionView.module.css'

interface AttentionViewProps {
  data: LoopsData
  meta: ApiMeta
  /**
   * The one attention number (new items that need the operator), from the shell signals
   * (`GET /api/signals`): the same value as the rail badge. null while it has not been read.
   */
  attention: AttentionReading | null
  /** Set when the latest refresh failed but an earlier reading is still shown. */
  refreshError: string | null
  onRetry: () => void
}

const cell = (value: number | null) => (value === null ? '—' : value)

type KeyedRow = Exclude<AttentionRow, { type: 'restricted' }>

export default function AttentionView({ data, meta, attention, refreshError, onRetry }: AttentionViewProps) {
  const now = useNow()
  const actions = useAckActions()
  // The server could not read its acknowledgements: every item is listed as new, and nothing can be acknowledged.
  const acksUnread = data.acks?.available === false
  const standingId = useId()
  const [confirmingAll, setConfirmingAll] = useState(false)
  const [standingOpen, setStandingOpen] = useState(false)
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

  const allRows = useMemo(() => buildAttentionRows(data, now), [data, now])
  const projectRows = useMemo(() => buildProjectRows(data.projects, now), [data.projects, now])
  // Restricted projects are information: counts on one row, never filtered, never acknowledged.
  const listRows = useMemo(() => allRows.filter((row) => row.type !== 'restricted'), [allRows])
  const restrictedRows = useMemo(() => allRows.filter((row) => row.type === 'restricted'), [allRows])

  const projectOptions = useMemo(
    () => [
      { value: 'all', label: 'All projects' },
      ...[...data.projects]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => ({
          value: p.id,
          label: isRestricted(p) ? `${p.id} (restricted)` : p.id,
        })),
    ],
    [data.projects],
  )
  // A project that vanished from the reading must not leave the list filtered to nothing.
  const activeProject = projectOptions.some((option) => option.value === project) ? project : 'all'
  const rows = useMemo(() => filterRows(listRows, filter, activeProject), [listRows, filter, activeProject])
  // Chip counts use the unit of the rows below (confirmations, findings), within the chosen project.
  const filterOptions = useMemo(
    () =>
      filterChipOptions(
        listRows,
        projectRows.filter((row) => !row.restricted),
        activeProject,
        filter,
      ),
    [listRows, projectRows, activeProject, filter],
  )

  // Everything the page holds, and what the filters leave of it.
  const all = useMemo(() => groupRows(listRows), [listRows])
  const shown = useMemo(() => groupRows(rows), [rows])
  const restricted = useMemo(
    () => restrictedSummary(filterRows(restrictedRows, 'all', activeProject)),
    [restrictedRows, activeProject],
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
  const clearFilters = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('filter')
        next.delete('scope')
        return next
      },
      { replace: true },
    )

  // ---- columns ----

  const stateColumn: DataTableColumn<KeyedRow> = {
    key: 'state',
    header: 'State',
    width: '128px',
    cell: (row) => <StatePill state={rowState(row)} label={rowWord(row)} />,
  }
  const projectColumn: DataTableColumn<KeyedRow> = {
    key: 'project',
    header: 'Where',
    width: '200px',
    cell: (row) => (
      <div className={styles.projectCell}>
        <span className={styles.projectName}>{rowScope(row)}</span>
        {row.type === 'system' && <span className={styles.tag}>system</span>}
      </div>
    ),
  }
  const whatColumn: DataTableColumn<KeyedRow> = {
    key: 'what',
    header: 'What',
    cell: (row) => <WhatCell row={row} />,
  }
  const whenColumn: DataTableColumn<KeyedRow> = {
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
  }
  const typeColumn: DataTableColumn<KeyedRow> = {
    key: 'code',
    header: 'Type',
    cell: (row) => {
      if (row.type === 'finding') return <FindingType code={row.code} />
      if (row.type === 'confirmation') return <span className={styles.muted}>{confirmationKindLabel(row.kind)}</span>
      return <span className={styles.muted}>—</span>
    },
  }

  const newColumns: DataTableColumn<KeyedRow>[] = [
    stateColumn,
    projectColumn,
    whatColumn,
    whenColumn,
    typeColumn,
    {
      key: 'actions',
      header: 'Action',
      width: '300px',
      cell: (row) =>
        row.ackKey ? (
          <AckControls ackKey={row.ackKey} name={rowSentence(row)} actions={actions} mode="new" disabled={acksUnread} />
        ) : null,
    },
  ]
  const standingColumns: DataTableColumn<KeyedRow>[] = [
    stateColumn,
    projectColumn,
    whatColumn,
    {
      key: 'standing',
      header: 'Standing',
      cell: (row) =>
        row.ack ? (
          <span className={styles.time} title={row.ack.at}>
            {ackStatus(row.ack, now)}
          </span>
        ) : null,
    },
    {
      key: 'actions',
      header: 'Action',
      width: '140px',
      cell: (row) =>
        row.ackKey ? (
          <AckControls
            ackKey={row.ackKey}
            name={rowSentence(row)}
            actions={actions}
            mode="standing"
            disabled={acksUnread}
          />
        ) : null,
    },
  ]
  const otherColumns: DataTableColumn<KeyedRow>[] = [stateColumn, projectColumn, whatColumn, whenColumn, typeColumn]

  // ---- projects table ----

  const projectColumns: DataTableColumn<ProjectRow>[] = [
    {
      key: 'project',
      header: 'Project',
      cell: (row) => (
        <div className={styles.projectCell}>
          <span className={styles.projectName}>{row.id}</span>
          {row.restricted && <span className={styles.tag}>restricted</span>}
        </div>
      ),
    },
    {
      key: 'findings',
      header: 'Open findings',
      align: 'end',
      mono: true,
      cell: (row) => row.openFindings,
    },
    {
      key: 'pending',
      header: 'Pending',
      align: 'end',
      mono: true,
      cell: (row) => cell(row.pendingConfirmations),
    },
    {
      key: 'overdue',
      header: 'Overdue',
      align: 'end',
      mono: true,
      cell: (row) =>
        row.overdueConfirmations !== null && row.overdueConfirmations > 0 ? (
          // Never colour alone: a shape and a word for screen readers go with the number.
          <span className={styles.overdue}>
            <StateMark state="warning" />
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

  // ---- the alarm line: the worst new item and its one action ----

  const worst = worstRow(all.fresh)
  const shellCount = attention?.count ?? null
  const alarmDetail = (() => {
    if (!worst) return undefined
    const words = attentionWords(shellCount !== null && shellCount > 0 ? shellCount : all.fresh.length)
    // Restricted counts are information on this page, never part of what needs the operator.
    const breakdown = attention?.breakdown ? { ...attention.breakdown, restricted: undefined } : null
    const parts = [words, breakdownWords(breakdown)].filter(Boolean)
    const error = worst.ackKey ? actions.errors[worst.ackKey] : undefined
    return (
      <>
        {parts.join(' · ')}
        {error && <AckError message={error} />}
      </>
    )
  })()
  const alarmAction =
    worst && worst.ackKey && !acksUnread
      ? {
          label: 'Acknowledge',
          busy: actions.busy.has(worst.ackKey),
          onClick: () => void actions.acknowledge(worst.ackKey as string),
        }
      : undefined
  // The shell counts new items but this list has none: it has not caught up yet. Say so, do not claim calm.
  const listBehind = !worst && shellCount !== null && shellCount > 0

  // Everything in the New block that can be acknowledged, as listed (filters narrow what is listed).
  const ackableKeys = shown.fresh.flatMap((row) => (row.ackKey ? [row.ackKey] : []))
  const acknowledgeAll = async () => {
    setConfirmingAll(false)
    await actions.acknowledgeAll(ackableKeys)
  }

  const filtered = filter !== 'all' || activeProject !== 'all'
  const counted = (group: AttentionRow[], total: number) => (filtered ? `${group.length} of ${total}` : String(total))
  const clearButton = <Button onClick={clearFilters}>Clear filters</Button>

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
          {errorText(meta.error)
            ? `; the latest read failed: ${errorText(meta.error)}`
            : '; the latest read did not finish'}
          .
        </Notice>
      )}

      {worst ? (
        <AlarmLine
          state={all.fresh.some((row) => rowState(row) === 'critical') ? 'critical' : 'warning'}
          title={rowSentence(worst)}
          detail={alarmDetail}
          action={alarmAction}
        />
      ) : listBehind ? (
        <Notice tone="info">
          {attentionWords(shellCount as number)} in the rail, but this list does not show them yet. Refresh to update
          it.
        </Notice>
      ) : (
        <div className={styles.calmBlock}>
          <p className={styles.calm}>Nothing new needs you.</p>
          {shellCount === null && (
            <p className={styles.unread}>
              <StateMark state="unavailable" />
              The attention count was not read.
            </p>
          )}
        </div>
      )}

      {acksUnread && (
        <p className={styles.unread}>
          <StateMark state="unavailable" />
          Acknowledgements not read. Every item is listed as new, and nothing can be acknowledged or shelved until
          they are.
        </p>
      )}

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
              Showing {rows.length} of {listRows.length}
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

      {actions.bulkError && (
        <div role="alert" className={styles.bulkError}>
          <StateMark state="critical" />
          <span>
            Acknowledged {actions.bulkError.done} of {actions.bulkError.total} and stopped: {actions.bulkError.message}
          </span>
        </div>
      )}

      {all.fresh.length > 0 && (
        <Block
          title="New"
          meta={counted(shown.fresh, all.fresh.length)}
          actions={
            ackableKeys.length > 1 && !acksUnread ? (
              <Button size="sm" loading={actions.bulkBusy} onClick={() => setConfirmingAll(true)}>
                Acknowledge all ({ackableKeys.length})
              </Button>
            ) : undefined
          }
          description="Each needs a decision: acknowledge it once you have seen it, or shelve it to silence it for a while."
          padding="none"
        >
          <DataTable
            caption="New items that need you"
            columns={newColumns}
            rows={shown.fresh}
            rowKey={(row) => row.key}
            onRowClick={(row) => openProject(row.project)}
            rowClickable={(row) => row.type !== 'system'}
            maxHeight="none"
            empty={<NothingMatches onClear={clearButton} />}
          />
        </Block>
      )}

      {all.standing.length > 0 && (
        <Block
          title="Standing"
          id={standingId}
          meta={counted(shown.standing, all.standing.length)}
          description={standingOpen ? 'Seen or silenced. They count again if they get worse.' : undefined}
          actions={
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={standingOpen}
              aria-controls={standingId}
              onClick={() => setStandingOpen((open) => !open)}
            >
              {standingOpen ? 'Hide' : 'Show'}
            </Button>
          }
          padding="none"
        >
          {standingOpen ? (
            <DataTable
              caption="Standing items: acknowledged or shelved"
              columns={standingColumns}
              rows={shown.standing}
              rowKey={(row) => row.key}
              onRowClick={(row) => openProject(row.project)}
              rowClickable={(row) => row.type !== 'system'}
              maxHeight="none"
              empty={<NothingMatches onClear={clearButton} />}
            />
          ) : undefined}
        </Block>
      )}

      {all.other.length > 0 && (
        <Block
          title="Also open"
          meta={counted(shown.other, all.other.length)}
          description="Not counted: these do not need you yet, so there is nothing to acknowledge."
          padding="none"
        >
          <DataTable
            caption="Open items that are not counted"
            columns={otherColumns}
            rows={shown.other}
            rowKey={(row) => row.key}
            onRowClick={(row) => openProject(row.project)}
            rowClickable={(row) => row.type !== 'system'}
            maxHeight="none"
            empty={<NothingMatches onClear={clearButton} />}
          />
        </Block>
      )}

      {restricted && (
        <Block title="Restricted" meta={`${restricted.projects} ${restricted.projects === 1 ? 'project' : 'projects'}`}>
          <p className={styles.restrictedRow}>
            <span>Details are restricted and not shown here.</span>
            <span className={styles.sub}>
              {count(restricted.openFindings, 'open finding', 'open findings')}
              {' · '}
              {restricted.pendingConfirmations === null
                ? 'pending not read'
                : `${restricted.pendingConfirmations} pending`}
              {' · '}
              {restricted.overdueConfirmations !== null && restricted.overdueConfirmations > 0 ? (
                <span className={styles.overdue}>
                  <StateMark state="warning" />
                  {restricted.overdueConfirmations} overdue
                </span>
              ) : (
                <span>{restricted.overdueConfirmations === null ? 'overdue not read' : '0 overdue'}</span>
              )}
            </span>
          </p>
        </Block>
      )}

      <Block title="Projects" meta={projectRows.length} padding="none">
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
      </Block>

      <Dialog
        open={confirmingAll}
        onClose={() => setConfirmingAll(false)}
        role="alertdialog"
        title={`Acknowledge ${ackableKeys.length} items?`}
        description={`This marks ${ackableKeys.length} new items as seen. They move to Standing and stop counting as new. If one of them changes or gets worse, it alerts you again.`}
        actions={
          <>
            <Button data-autofocus onClick={() => setConfirmingAll(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void acknowledgeAll()}>
              Acknowledge {ackableKeys.length}
            </Button>
          </>
        }
      />

      <ProjectDrawer project={selected} onClose={closeProject} now={now} />
    </div>
  )
}

function count(value: number | null, one: string, many: string) {
  return value === null ? `${many} not read` : `${value} ${value === 1 ? one : many}`
}

function NothingMatches({ onClear }: { onClear: ReactNode }) {
  return (
    <EmptyState title="Nothing matches" description="No items match the current filter and project." action={onClear} />
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
  if (row.type === 'system') {
    return (
      <div className={styles.what}>
        <span>{rowTitle(row)}</span>
        {row.held && <span className={styles.sub}>Held at its last state while the reading refreshes</span>}
      </div>
    )
  }
  return <span>Details are restricted</span>
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
