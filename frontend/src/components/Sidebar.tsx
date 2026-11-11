import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { NavLink } from 'react-router-dom'
import type { AppRouteDefinition } from '../appRoutes'
import { useApi } from '../lib/hooks'
import { normalizeCronStatus } from '../lib/status'
import { useNavigation } from '../lib/useNavigation'
import type { CronApiResponse } from '../pages/cron/types'
import { MissionControlMark } from './MissionControlMark'
import { cx } from './ui/cx'
import styles from './Sidebar.module.css'

interface SidebarProps {
  /** Desktop: collapsed to a 56px icon rail. Ignored under 900px. */
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Under 900px: the off-canvas drawer is open. */
  open: boolean
  onClose: () => void
}

type Section = NonNullable<AppRouteDefinition['section']>

const GROUPS: Array<{ key: Section | 'overview'; label: string | null }> = [
  { key: 'overview', label: null },
  { key: 'operate', label: 'Operate' },
  { key: 'know', label: 'Know' },
  { key: 'run', label: 'Run' },
]

interface Badge {
  count: number
  tone: 'warning' | 'critical'
  /** Spoken after the label: "3 failed". */
  word: string
}

/** Abnormal-only counts: nothing is shown when the count is zero or unknown. */
function useNavBadges(): Record<string, Badge | undefined> {
  const { data: cron } = useApi<CronApiResponse>('/api/cron', 30000)
  return useMemo(() => {
    const badges: Record<string, Badge | undefined> = {}
    const jobs = cron?.jobs
    if (Array.isArray(jobs)) {
      const failed = jobs.filter((job) => normalizeCronStatus(job.status, job.enabled) === 'failed').length
      if (failed > 0) badges['/automations'] = { count: failed, tone: 'critical', word: 'failed' }
    }
    return badges
  }, [cron])
}

export default function Sidebar({ collapsed, onToggleCollapsed, open, onClose }: SidebarProps) {
  const { name, primary, utility } = useNavigation()
  const badges = useNavBadges()
  const asideRef = useRef<HTMLElement>(null)

  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        items: primary.filter((route) => (route.section ?? 'overview') === group.key),
      })).filter((group) => group.items.length > 0),
    [primary],
  )

  // Off-canvas drawer: Esc closes, focus moves in, and returns to the menu button on close.
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    asideRef.current?.querySelector<HTMLElement>('a')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [open, onClose])

  const renderLink = (route: AppRouteDefinition) => {
    const Icon = route.icon
    if (!Icon) return null
    const badge = badges[route.path]
    return (
      <NavLink
        key={route.path}
        to={route.path}
        end={route.path === '/'}
        data-tooltip={route.label}
        className={({ isActive }) => cx(styles.item, isActive && styles.itemActive)}
        onClick={onClose}
      >
        <Icon className={styles.icon} size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles.label}>{route.label}</span>
        {badge && (
          <span className={styles.badge} data-tone={badge.tone}>
            {badge.count}
            <span className="visually-hidden"> {badge.word}</span>
          </span>
        )}
      </NavLink>
    )
  }

  return (
    <aside
      id="mission-control-sidebar"
      ref={asideRef}
      className={cx(styles.sidebar, collapsed && styles.collapsed, open && styles.open)}
      aria-label="Main"
    >
      <div className={styles.brand}>
        <span className={styles.mark}>
          <MissionControlMark size={18} />
        </span>
        <span className={styles.brandName}>{name}</span>
      </div>

      <nav className={styles.nav} aria-label="Primary">
        {groups.map((group) => (
          <div key={group.key} className={styles.group}>
            {group.label && <h2 className={styles.groupLabel}>{group.label}</h2>}
            {group.items.map(renderLink)}
          </div>
        ))}
      </nav>

      <nav className={styles.utility} aria-label="Utility">
        {utility.map(renderLink)}
        <button
          type="button"
          className={cx(styles.item, styles.collapseToggle)}
          data-tooltip={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          aria-controls="mission-control-sidebar"
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen className={styles.icon} size={16} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <PanelLeftClose className={styles.icon} size={16} strokeWidth={1.75} aria-hidden="true" />
          )}
          <span className={styles.label}>Collapse</span>
        </button>
      </nav>
    </aside>
  )
}
