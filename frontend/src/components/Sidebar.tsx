import { NavLink } from 'react-router-dom'
import { type CSSProperties, useMemo, useState, useEffect } from 'react'
import { Activity, Bot } from 'lucide-react'
import { sidebarRoutes, type AppRouteDefinition } from '../appRoutes'
import { timeAgo, useApi } from '../lib/hooks'
import styles from './Sidebar.module.css'

interface McConfig {
  name?: string
  subtitle?: string
  modules?: Record<string, boolean>
}

type StatusPayload = {
  agent?: {
    model?: string
    activeSessions?: number
  }
  heartbeat?: {
    lastHeartbeat?: number
    lastHeartbeatAt?: number
  }
}

interface SidebarProps {
  isOpen?: boolean
  onClose?: () => void
}

const navSections: Array<{ key: NonNullable<AppRouteDefinition['section']>, label: string }> = [
  { key: 'operate', label: 'Operate' },
  { key: 'intelligence', label: 'Intelligence' },
  { key: 'system', label: 'System' },
  { key: 'audit', label: 'Audit' },
]

export default function Sidebar({ isOpen = false, onClose }: SidebarProps) {
  const [config, setConfig] = useState<McConfig | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const { data: statusData } = useApi<StatusPayload>('/api/status', 30000)

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(setConfig)
      .catch(() => setConfig({ name: 'Mission Control', subtitle: 'Mission Control', modules: {} }))
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  // Filter nav items based on enabled modules
  const navItems = config?.modules
    ? sidebarRoutes.filter(item => config.modules![item.module] !== false)
    : sidebarRoutes

  const groupedItems = useMemo(() => {
    return navSections
      .map((section) => ({
        ...section,
        items: navItems.filter((item) => (item.section || 'system') === section.key),
      }))
      .filter((section) => section.items.length > 0)
  }, [navItems])

  const displayName = config?.name || 'Mission Control'
  const subtitle = config?.subtitle || 'Mission Control'
  const heartbeatTs = statusData?.heartbeat?.lastHeartbeat || statusData?.heartbeat?.lastHeartbeatAt || 0
  const heartbeatAge = heartbeatTs ? timeAgo(new Date(heartbeatTs * 1000).toISOString()) : 'No heartbeat'
  const heartbeatHours = heartbeatTs ? (now - heartbeatTs * 1000) / 36e5 : Infinity
  const stateColor = heartbeatHours > 2 ? '#ff9500' : '#32d74b'

  return (
    <aside className={`macos-sidebar ${styles.sidebar} ${isOpen ? 'open' : ''}`}>
      <div className={styles.brand}>
        <div className={styles.brandRow}>
          <div className={styles.brandIcon}>
            <Activity size={17} />
          </div>
          <div className={styles.brandText}>
            <h1 className={styles.brandTitle}>{subtitle}</h1>
            <p className={styles.brandSubtitle}>Operator console</p>
          </div>
        </div>

        <div className={styles.statusCard} style={{ '--sidebar-state-color': stateColor } as CSSProperties}>
          <div className={styles.statusTop}>
            <div>
              <p className={styles.statusLabel}>Runtime state</p>
              <div className={styles.statusValue}>{heartbeatHours > 2 ? 'Watch heartbeat' : 'Live'}</div>
            </div>
            <span className={styles.statusDot} />
          </div>
          <p className={styles.statusMeta}>
            {heartbeatAge} · {statusData?.agent?.model || 'model unknown'}
          </p>
        </div>
      </div>

      <div className={styles.divider} />

      <nav className={styles.nav}>
        {groupedItems.map((section) => (
          <section key={section.key} className={styles.section}>
            <h2 className={styles.sectionTitle}>{section.label}</h2>
            <div className={styles.items}>
              {section.items.map((item) => (
                item.icon ? (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === '/'}
                    className={({ isActive }) =>
                      `${styles.item} ${isActive ? styles.itemActive : ''}`
                    }
                    onClick={onClose}
                  >
                    <item.icon className={styles.itemIcon} size={16} strokeWidth={2} />
                    <span className={styles.itemCopy}>
                      <span className={styles.itemLabel}>{item.label}</span>
                      {item.description && <span className={styles.itemDescription}>{item.description}</span>}
                    </span>
                  </NavLink>
                ) : null
              ))}
            </div>
          </section>
        ))}
      </nav>

      <div className={styles.divider} />

      <div className={styles.footer}>
        <div className={styles.footerRow}>
          <div className={styles.footerIcon}>
            <Bot size={16} />
            <span className={styles.footerLiveDot} />
          </div>
          <div className={styles.footerText}>
            <p className={styles.footerTitle}>{displayName}</p>
            <p className={styles.footerMeta}>{statusData?.agent?.activeSessions || 0} active sessions</p>
          </div>
        </div>
      </div>
    </aside>
  )
}
