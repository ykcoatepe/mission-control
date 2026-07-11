import { NavLink } from 'react-router-dom'
import { useMemo } from 'react'
import {
  isRouteEnabled,
  primarySidebarRoutes,
  utilitySidebarRoutes,
  type AppRouteDefinition,
} from '../appRoutes'
import { MissionControlMark } from './MissionControlMark'
import { useApi } from '../lib/hooks'
import type { OperationsOverview, OperationSystemId } from '../pages/brain/types'
import styles from './Sidebar.module.css'

const EMPTY_CONFIG: McConfig = { name: 'Mission Control', subtitle: 'Mission Control', modules: {} }

interface McConfig {
  name?: string
  subtitle?: string
  modules?: Record<string, boolean>
}

interface SidebarProps {
  isOpen?: boolean
  onClose?: () => void
}

const navSections: Array<{ key: NonNullable<AppRouteDefinition['section']>, label: string }> = [
  { key: 'core', label: 'Core' },
  { key: 'intelligence', label: 'Intelligence' },
  { key: 'system', label: 'System' },
]

const systemIds: OperationSystemId[] = ['gbrain', 'hermes', 'openclaw']

export default function Sidebar({ isOpen = false, onClose }: SidebarProps) {
  const { data: overview } = useApi<OperationsOverview>('/api/operations/overview', 30000)
  const { data: configData, error: configError } = useApi<McConfig>('/api/config')
  const config = configData ?? (configError ? EMPTY_CONFIG : null)

  const primaryItems = config?.modules
    ? primarySidebarRoutes.filter((item) => isRouteEnabled(item, config.modules!))
    : primarySidebarRoutes
  const utilityItems = config?.modules
    ? utilitySidebarRoutes.filter((item) => isRouteEnabled(item, config.modules!))
    : utilitySidebarRoutes

  const groupedItems = useMemo(() => {
    return navSections
      .map((section) => ({
        ...section,
        items: primaryItems.filter((item) => (item.section || 'system') === section.key),
      }))
      .filter((section) => section.items.length > 0)
  }, [primaryItems])

  const subtitle = config?.subtitle || 'Mission Control'

  return (
    <aside id="mission-control-sidebar" className={`macos-sidebar ${styles.sidebar} ${isOpen ? 'open' : ''}`}>
      <div className={styles.brand}>
        <div className={styles.brandRow}>
          <div className={styles.brandIcon}>
            <MissionControlMark size={19} />
          </div>
          <div className={styles.brandText}>
            <h1 className={styles.brandTitle}>{subtitle}</h1>
            <p className={styles.brandSubtitle}>Operator console</p>
          </div>
        </div>

        <NavLink
          to="/"
          className={styles.systemStack}
          aria-label="Open shared brain status"
          onClick={onClose}
        >
          {systemIds.map((id) => {
            const system = overview?.systems[id]
            const state = system?.state || 'unavailable'
            const freshness = system?.freshness || 'unavailable'
            return (
              <span
                key={id}
                className={styles.systemRow}
                data-state={state}
                aria-label={`${system?.label || id}: ${state}; freshness ${freshness}`}
              >
                <span className={styles.systemName}>
                  <i className={styles.systemDot} aria-hidden="true" />
                  {system?.label || id}
                </span>
                <span className={styles.systemMeta}>
                  <strong>{state}</strong>
                  <small>{freshness}</small>
                </span>
              </span>
            )
          })}
        </NavLink>
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

      {utilityItems.length > 0 ? (
        <div className={styles.utilityNav}>
          <div className={styles.divider} />
          <nav aria-label="Utility navigation" className={styles.utilityItems}>
            {utilityItems.map((item) => item.icon ? (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  `${styles.item} ${isActive ? styles.itemActive : ''}`
                }
                onClick={onClose}
              >
                <item.icon className={styles.itemIcon} size={16} strokeWidth={2} />
                <span className={styles.itemCopy}>
                  <span className={styles.itemLabel}>{item.label}</span>
                </span>
              </NavLink>
            ) : null)}
          </nav>
        </div>
      ) : null}
    </aside>
  )
}
