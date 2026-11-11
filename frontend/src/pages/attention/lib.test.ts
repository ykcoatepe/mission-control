import { describe, expect, it } from 'vitest'
import {
  buildAttentionRows,
  buildProjectRows,
  compareDeadline,
  confirmationKindLabel,
  deadlineTiming,
  errorText,
  filterRows,
  findingAge,
  groupFindingsByCode,
  severityState,
  sortConfirmations,
  summarize,
} from './lib'
import type { AttentionEntry, Confirmation, LoopProject, LoopsData, OpenProject } from './types'

const NOW = Date.parse('2026-11-11T12:00:00.000Z')
const HOUR = 3_600_000

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString()
}

function confirmation(overrides: Partial<Confirmation> = {}): Confirmation {
  return {
    id: 'c1',
    unit: 'unit',
    verification: 'check it',
    deadline: iso(5 * HOUR),
    overdue: false,
    state: 'open',
    kind: 'live_confirmation',
    dependsOn: null,
    ...overrides,
  }
}

function project(overrides: Partial<OpenProject> = {}): OpenProject {
  return {
    id: 'alpha',
    restricted: false,
    title: 'alpha',
    outcome: null,
    openFindings: { total: 0, bySeverity: { error: 0, warning: 0, info: 0 }, byCode: {} },
    pendingConfirmations: [],
    participants: [],
    lastActivityAt: null,
    errors: [],
    ...overrides,
  }
}

function data(projects: LoopProject[], attention: AttentionEntry[] = []): LoopsData {
  return {
    observedAt: iso(0),
    totals: { projects: projects.length, openFindings: 0, pendingConfirmations: 0, overdueConfirmations: 0 },
    projects,
    attention,
  }
}

const restricted: LoopProject = {
  id: 'argus',
  restricted: true,
  openFindings: 117,
  pendingConfirmations: 74,
  overdueConfirmations: 21,
  countsBasis: 'mloop-check',
}

describe('deadlineTiming', () => {
  it('shows a missing deadline as a dash, never as now', () => {
    expect(deadlineTiming(null, false, NOW)).toEqual({ kind: 'none', text: '—' })
    expect(deadlineTiming(undefined, false, NOW)).toEqual({ kind: 'none', text: '—' })
    expect(deadlineTiming('not a date', false, NOW)).toEqual({ kind: 'none', text: '—' })
  })

  it('does not call a deadline-less item overdue unless the server says so', () => {
    expect(deadlineTiming(null, false, NOW).kind).toBe('none')
    expect(deadlineTiming(null, true, NOW)).toEqual({ kind: 'overdue', text: 'overdue' })
  })

  it('counts forward to a future deadline and back from a past one', () => {
    expect(deadlineTiming(iso(5 * HOUR), false, NOW)).toEqual({ kind: 'upcoming', text: 'due in 5h' })
    expect(deadlineTiming(iso(-3 * 24 * HOUR), true, NOW)).toEqual({ kind: 'overdue', text: '3d overdue' })
  })

  it('treats a passed deadline as overdue even if the flag is stale', () => {
    expect(deadlineTiming(iso(-2 * HOUR), false, NOW)).toEqual({ kind: 'overdue', text: '2h overdue' })
  })
})

describe('findingAge', () => {
  it('is a dash when the time is missing', () => {
    expect(findingAge(null, NOW)).toBe('—')
    expect(findingAge('garbage', NOW)).toBe('—')
  })
  it('is a compact age otherwise', () => {
    expect(findingAge(iso(-26 * HOUR), NOW)).toBe('1d')
  })
})

describe('sorting confirmations', () => {
  it('orders by deadline and puts a missing deadline last', () => {
    const sorted = sortConfirmations([
      confirmation({ id: 'none', deadline: null }),
      confirmation({ id: 'late', deadline: iso(9 * HOUR) }),
      confirmation({ id: 'past', deadline: iso(-HOUR), overdue: true }),
    ])
    expect(sorted.map((c) => c.id)).toEqual(['past', 'late', 'none'])
  })
  it('compareDeadline ties two missing deadlines', () => {
    expect(compareDeadline(null, null)).toBe(0)
    expect(compareDeadline(null, iso(0))).toBeGreaterThan(0)
  })
})

describe('buildAttentionRows', () => {
  const attention: AttentionEntry[] = [
    { project: 'alpha', kind: 'finding', severity: 'info', code: 'I1', subject: 's', detail: 'd', at: iso(-HOUR) },
    { project: 'alpha', kind: 'finding', severity: 'warning', code: 'W_NEW', subject: 's', detail: 'd', at: iso(-HOUR) },
    { project: 'alpha', kind: 'finding', severity: 'warning', code: 'W_OLD', subject: 's', detail: 'd', at: iso(-30 * HOUR) },
    { project: 'alpha', kind: 'finding', severity: 'error', code: 'E1', subject: 's', detail: 'd', at: iso(-2 * HOUR) },
    { project: 'argus', kind: 'restricted', restricted: true, severity: 'error', count: 117 },
  ]
  const alpha = project({
    pendingConfirmations: [
      confirmation({ id: 'soon', deadline: iso(2 * HOUR) }),
      confirmation({ id: 'past', deadline: iso(-HOUR), overdue: true }),
      confirmation({ id: 'open-ended', deadline: null }),
    ],
  })

  it('ranks errors, overdue confirmations, warnings, pending confirmations, then info', () => {
    const rows = buildAttentionRows(data([alpha, restricted], attention), NOW)
    const order = rows.map((row) =>
      row.type === 'finding' ? row.code : row.type === 'confirmation' ? (row.id ?? '') : 'restricted',
    )
    expect(order).toEqual(['E1', 'restricted', 'past', 'W_OLD', 'W_NEW', 'soon', 'open-ended', 'I1'])
  })

  it('keeps a confirmation without a deadline, with no deadline', () => {
    const rows = buildAttentionRows(data([alpha], []), NOW)
    const open = rows.find((row) => row.type === 'confirmation' && row.id === 'open-ended')
    expect(open).toMatchObject({ deadline: null, overdue: false })
  })

  it('makes a count-only row for a restricted project and no row for an empty one', () => {
    const rows = buildAttentionRows(data([restricted], attention), NOW)
    expect(rows.filter((row) => row.type === 'restricted')).toEqual([
      expect.objectContaining({
        project: 'argus',
        severity: 'error',
        openFindings: 117,
        pendingConfirmations: 74,
        overdueConfirmations: 21,
      }),
    ])
    const empty = { ...restricted, openFindings: 0, pendingConfirmations: 0, overdueConfirmations: 0 }
    expect(buildAttentionRows(data([empty]), NOW)).toEqual([])
  })

  it('does not rate a restricted project the API gave no rating for', () => {
    const rows = buildAttentionRows(data([restricted], []), NOW)
    expect(rows[0]).toMatchObject({ type: 'restricted', severity: null })
  })

  it('drops findings that restate a confirmation row, but only when confirmations were read', () => {
    const due: AttentionEntry = {
      project: 'alpha',
      kind: 'finding',
      severity: 'info',
      code: 'TEYIT_DUE',
      subject: 'c1',
      detail: '',
      at: iso(-HOUR),
    }
    const read = buildAttentionRows(data([project({ pendingConfirmations: [confirmation()] })], [due]), NOW)
    expect(read.filter((row) => row.type === 'finding')).toHaveLength(0)
    const unread = buildAttentionRows(data([project({ pendingConfirmations: null })], [due]), NOW)
    expect(unread.filter((row) => row.type === 'finding')).toHaveLength(1)
  })

  it('makes no confirmation rows for a project whose confirmations were not read', () => {
    const rows = buildAttentionRows(data([project({ pendingConfirmations: null })]), NOW)
    expect(rows).toEqual([])
  })
})

describe('filterRows', () => {
  const rows = buildAttentionRows(
    data(
      [
        project({
          pendingConfirmations: [
            confirmation({ id: 'late', deadline: iso(-HOUR), overdue: true }),
            confirmation({ id: 'soon' }),
          ],
        }),
        project({ id: 'beta', title: 'beta' }),
        restricted,
      ],
      [
        { project: 'alpha', kind: 'finding', severity: 'warning', code: 'W', subject: 's', detail: 'd', at: iso(-HOUR) },
        { project: 'beta', kind: 'finding', severity: 'info', code: 'I', subject: 's', detail: 'd', at: iso(-HOUR) },
      ],
    ),
    NOW,
  )
  const kinds = (filter: Parameters<typeof filterRows>[1], project = 'all') =>
    filterRows(rows, filter, project).map((row) =>
      row.type === 'confirmation' ? (row.id ?? '') : row.type === 'finding' ? row.code : 'restricted',
    )

  it('all shows everything', () => {
    expect(kinds('all')).toHaveLength(rows.length)
  })
  it('overdue shows overdue confirmations and restricted projects with overdue ones', () => {
    expect(kinds('overdue').sort()).toEqual(['late', 'restricted'])
  })
  it('pending shows every pending confirmation', () => {
    expect(kinds('pending').sort()).toEqual(['late', 'restricted', 'soon'])
  })
  it('findings shows findings only', () => {
    expect(kinds('findings').sort()).toEqual(['I', 'W', 'restricted'])
  })
  it('a project filter narrows every view', () => {
    expect(kinds('all', 'beta')).toEqual(['I'])
    expect(kinds('overdue', 'beta')).toEqual([])
  })
  it('a restricted project with no overdue items is not an overdue row', () => {
    const calm = buildAttentionRows(data([{ ...restricted, overdueConfirmations: 0 }]), NOW)
    expect(filterRows(calm, 'overdue', 'all')).toEqual([])
  })
})

describe('buildProjectRows', () => {
  it('keeps unread readings null instead of zero', () => {
    const rows = buildProjectRows([project({ pendingConfirmations: null, participants: null })], NOW)
    expect(rows[0]).toMatchObject({ pendingConfirmations: null, overdueConfirmations: null, participants: null })
  })

  it('counts participants alive out of the total', () => {
    const rows = buildProjectRows(
      [
        project({
          participants: [
            { name: 'a', role: null, host: null, alive: true },
            { name: 'b', role: null, host: null, alive: false },
          ],
        }),
      ],
      NOW,
    )
    expect(rows[0].participants).toEqual({ alive: 1, total: 2 })
  })

  it('has no participants or activity for a restricted project', () => {
    const [row] = buildProjectRows([restricted], NOW)
    expect(row).toMatchObject({
      restricted: true,
      openFindings: 117,
      pendingConfirmations: 74,
      overdueConfirmations: 21,
      participants: null,
      lastActivityAt: null,
    })
  })

  it('puts projects with overdue confirmations first, unread ones after read ones', () => {
    const rows = buildProjectRows(
      [
        project({ id: 'quiet' }),
        project({ id: 'unread', pendingConfirmations: null }),
        project({ id: 'late', pendingConfirmations: [confirmation({ overdue: true })] }),
      ],
      NOW,
    )
    expect(rows.map((row) => row.id)).toEqual(['late', 'quiet', 'unread'])
  })
})

describe('summarize', () => {
  it('counts projects with open items and uses the API totals', () => {
    const d = data([
      project({ id: 'a', openFindings: { total: 2, bySeverity: { error: 0, warning: 2, info: 0 }, byCode: {} } }),
      project({ id: 'b', pendingConfirmations: [confirmation()] }),
      project({ id: 'c' }),
      restricted,
    ])
    d.totals = { projects: 4, openFindings: 119, pendingConfirmations: 75, overdueConfirmations: 21 }
    expect(summarize(d)).toMatchObject({
      projects: 4,
      projectsWithOpenItems: 3,
      openFindings: 119,
      pendingConfirmations: 75,
      overdueConfirmations: 21,
      unreadProjects: 0,
    })
  })

  it('reports unread projects and never turns a missing total into zero', () => {
    const d = data([project({ pendingConfirmations: null })])
    d.totals = { projects: 1 } as LoopsData['totals']
    const summary = summarize(d)
    expect(summary.unreadProjects).toBe(1)
    expect(summary.openFindings).toBeNull()
    expect(summary.overdueConfirmations).toBeNull()
  })
})

describe('groupFindingsByCode', () => {
  it('groups by code, worst severity first, oldest finding first inside a group', () => {
    const groups = groupFindingsByCode([
      { code: 'B', subject: '1', severity: 'warning', detail: null, at: iso(-HOUR) },
      { code: 'A', subject: '2', severity: 'info', detail: null, at: null },
      { code: 'B', subject: '3', severity: 'warning', detail: null, at: iso(-5 * HOUR) },
      { code: 'C', subject: '4', severity: 'error', detail: null, at: iso(-HOUR) },
    ])
    expect(groups.map((g) => g.code)).toEqual(['C', 'B', 'A'])
    expect(groups[1].findings.map((f) => f.subject)).toEqual(['3', '1'])
  })

  it('is empty for no findings', () => {
    expect(groupFindingsByCode([])).toEqual([])
  })
})

describe('words and states', () => {
  it('maps severity to a state and never to healthy', () => {
    expect(severityState('error')).toBe('critical')
    expect(severityState('warning')).toBe('warning')
    expect(severityState('info')).toBe('inactive')
    expect(severityState(null)).toBe('unavailable')
    expect(severityState('mystery' as never)).toBe('unavailable')
  })
  it('humanises a confirmation kind and dashes a missing one', () => {
    expect(confirmationKindLabel('live_confirmation')).toBe('live confirmation')
    expect(confirmationKindLabel(null)).toBe('—')
    expect(confirmationKindLabel('')).toBe('—')
  })
  it('reads an error from either envelope form', () => {
    expect(errorText('boom')).toBe('boom')
    expect(errorText({ code: 'x', message: 'bad' })).toBe('bad')
    expect(errorText({ code: 'x' })).toBe('x')
    expect(errorText(null)).toBeNull()
  })
})
