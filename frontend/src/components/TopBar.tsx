import { Bot, Menu, Moon, RefreshCw, Search, Sun } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { useApi } from '../lib/hooks'
import { annunciatorFor, attentionSummary } from '../lib/overview'
import { stateLabel } from '../lib/state'
import { useRefreshData } from '../lib/useRefreshData'
import { useTheme } from '../lib/theme'
import { appRoutes } from '../appRoutes'
import type { OperationsOverview, OperationSystemId } from '../pages/brain/types'
import { Kbd } from './ui/Kbd'
import { IconButton } from './ui/IconButton'
import { StatePill } from './ui/StatePill'
import { TimeAgo } from './ui/TimeAgo'
import { usePageTitle } from './ui/pageTitleContext'
import styles from './TopBar.module.css'

const SYSTEM_IDS: OperationSystemId[] = ['gbrain', 'hermes', 'openclaw']
const FALLBACK_LABEL: Record<OperationSystemId, string> = {
  gbrain: 'GBrain',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
}

interface TopBarProps {
  onOpenMenu: () => void
  onOpenPalette: () => void
}

function routeLabel(pathname: string): string {
  const exact = appRoutes.find((route) => route.path === pathname)
  if (exact) return exact.label
  const prefix = appRoutes
    .filter((route) => route.path !== '/' && pathname.startsWith(`${route.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return prefix?.label ?? 'Mission Control'
}

function paletteHint(): string {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'
}

export default function TopBar({ onOpenMenu, onOpenPalette }: TopBarProps) {
  const location = useLocation()
  const pageTitle = usePageTitle()
  const { data: overview, loading, error } = useApi<OperationsOverview>('/api/operations/overview', 30000)
  const { refresh, refreshing } = useRefreshData()
  const { theme, toggleTheme } = useTheme()

  const title = pageTitle ?? routeLabel(location.pathname)
  const attention = attentionSummary(overview)
  const hint = paletteHint()
  const nextTheme = theme === 'dark' ? 'light' : 'dark'

  return (
    <header className={styles.bar}>
      <IconButton
        label="Open navigation"
        className={styles.menu}
        icon={<Menu size={18} />}
        aria-controls="mission-control-sidebar"
        onClick={onOpenMenu}
      />
      <h1 className={styles.title}>{title}</h1>

      <div className={styles.spacer} />

      <ul className={styles.annunciators} aria-label="Systems">
        {SYSTEM_IDS.map((id) => {
          const system = overview?.systems?.[id]
          const label = system?.label || FALLBACK_LABEL[id]
          const href = system?.detailHref || '/'
          const reading = loading && !overview
          // No overview at all after loading finished: the systems could not be read.
          const lit = system ? annunciatorFor(system) : reading ? null : { state: 'unavailable' as const, word: stateLabel('unavailable').toLowerCase() }
          const state = lit?.state ?? 'reading'
          const showWord = reading || (lit !== null && lit.state !== 'healthy')
          const word = reading ? 'reading…' : lit?.word
          return (
            <li key={id}>
              <Link
                to={href}
                className={styles.annunciator}
                data-state={state}
                aria-label={`${label}: ${error && !overview ? 'could not be read' : word}`}
                title={`${label}: ${error && !overview ? 'could not be read' : word}`}
              >
                <span className={styles.annDot} aria-hidden="true" />
                <span className={styles.annName}>{label}</span>
                {showWord && <span className={styles.annWord}>{word}</span>}
              </Link>
            </li>
          )
        })}
      </ul>

      {attention && attention.count > 0 && (
        <Link to="/" className={styles.attention} data-state={attention.state}>
          <StatePill
            state={attention.state}
            label={attention.count === 1 ? '1 needs attention' : `${attention.count} need attention`}
          />
        </Link>
      )}

      <button type="button" className={styles.palette} onClick={onOpenPalette} aria-label="Open command palette">
        <Search size={14} aria-hidden="true" />
        <span className={styles.paletteText}>Search or run…</span>
        <Kbd>{hint}</Kbd>
      </button>

      <div className={styles.age} aria-live="off">
        <span className={styles.ageText}>
          {overview?.generatedAt ? (
            <>
              Updated <TimeAgo value={overview.generatedAt} />
            </>
          ) : loading ? (
            'Reading…'
          ) : (
            'Not read'
          )}
        </span>
        <IconButton
          label="Refresh data"
          size="sm"
          className={refreshing ? styles.spinning : undefined}
          icon={<RefreshCw size={14} />}
          disabled={refreshing}
          onClick={refresh}
        />
      </div>

      <IconButton
        label={`Switch to ${nextTheme} theme`}
        className={styles.theme}
        icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        onClick={toggleTheme}
      />
      <IconButton
        label="Open assistant"
        icon={<Bot size={16} />}
        onClick={() => window.dispatchEvent(new CustomEvent('open-chat'))}
      />
    </header>
  )
}
