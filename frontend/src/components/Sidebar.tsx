import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { NavLink } from 'react-router-dom'
import type { AppRouteDefinition } from '../appRoutes'
import { useApi } from '../lib/hooks'
import { SIGNALS_POLL_MS, SIGNALS_URL, navBadges, navUnread } from '../lib/signals'
import type { SignalsEnvelope } from '../lib/signals'
import type { NavBadge as NavBadgeReading } from '../lib/signals'
import { useNavigation } from '../lib/useNavigation'
import { MissionControlMark } from './MissionControlMark'
import { cx } from './ui/cx'
import { IconButton } from './ui/IconButton'
import { NavBadge } from './ui/NavBadge'
import { StateMark } from './ui/StateMark'
import { useMediaQuery } from './ui/useMediaQuery'
import { useModal } from './ui/useModal'
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

/** The rail is one flat list in the order of the routes; the groups only add a little air between them. */
const GROUPS: Array<{ key: Section | 'overview' }> = [{ key: 'overview' }, { key: 'operate' }, { key: 'know' }, { key: 'run' }]

/**
 * Badges follow the badge rule: only NEW, actionable, unacknowledged items are counted, and nothing is
 * drawn at zero. A count that could not be read gets a hollow "not read" mark, because silence would read
 * as "nothing is new".
 */
function useNavBadges(): { badges: Record<string, NavBadgeReading | undefined>; unread: Record<string, true | undefined> } {
  const { data, loading } = useApi<SignalsEnvelope>(SIGNALS_URL, SIGNALS_POLL_MS)
  const signals = data?.data ?? null
  return useMemo(
    () => ({ badges: navBadges(signals), unread: navUnread(signals, { loading }) }),
    [signals, loading],
  )
}

export default function Sidebar({ collapsed, onToggleCollapsed, open, onClose }: SidebarProps) {
  const { name, primary, utility } = useNavigation()
  const { badges, unread } = useNavBadges()
  const asideRef = useRef<HTMLElement>(null)

  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        items: primary.filter((route) => (route.section ?? 'overview') === group.key),
      })).filter((group) => group.items.length > 0),
    [primary],
  )

  // Under 900px the sidebar is an off-canvas drawer. While it is open it is a modal dialog:
  // focus moves in, Tab is trapped, Esc closes and focus returns to the menu button.
  const drawerMode = useMediaQuery('(max-width: 899px)')
  const modal = drawerMode && open
  useModal(modal, onClose, asideRef, () => document.querySelector<HTMLElement>('[data-nav-menu]'))

  const renderLink = (route: AppRouteDefinition) => {
    const Icon = route.icon
    if (!Icon) return null
    const badge = badges[route.path]
    const notRead = !badge && unread[route.path] === true
    const tooltip = badge ? `${route.label}: ${badge.count} ${badge.word}` : notRead ? `${route.label}: count not read` : route.label
    return (
      <NavLink
        key={route.path}
        to={route.path}
        end={route.path === '/'}
        data-tooltip={tooltip}
        className={({ isActive }) => cx(styles.item, isActive && styles.itemActive)}
        onClick={onClose}
      >
        <Icon className={styles.icon} size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles.label}>{route.label}</span>
        {badge && <NavBadge count={badge.count} state={badge.tone} word={badge.word} className={styles.badge} />}
        {notRead && (
          <span className={styles.unread} title="Count not read">
            <StateMark state="unavailable" />
            <span className="visually-hidden">count not read</span>
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
      aria-label={modal ? 'Navigation' : 'Main'}
      role={modal ? 'dialog' : undefined}
      aria-modal={modal ? true : undefined}
      tabIndex={modal ? -1 : undefined}
    >
      <div className={styles.brand}>
        <span className={styles.mark}>
          <MissionControlMark size={20} />
        </span>
        <span className={styles.brandName}>{name}</span>
        <IconButton
          label="Close navigation"
          size="sm"
          className={styles.closeButton}
          icon={<X size={16} />}
          onClick={onClose}
        />
      </div>

      <nav className={styles.nav} aria-label="Primary">
        {groups.map((group) => (
          <div key={group.key} className={styles.group}>
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
