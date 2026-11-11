import { Menu, Moon, RefreshCw, Search, Sun } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { useApi } from '../lib/hooks'
import { SIGNALS_POLL_MS, SIGNALS_URL, annunciators, attentionPill, signalsStale } from '../lib/signals'
import type { SignalsEnvelope } from '../lib/signals'
import { useNow } from '../lib/useNow'
import { useRefreshData } from '../lib/useRefreshData'
import { useTheme } from '../lib/theme'
import { appRoutes } from '../appRoutes'
import { Kbd } from './ui/Kbd'
import { IconButton } from './ui/IconButton'
import { StatePill } from './ui/StatePill'
import { TimeAgo } from './ui/TimeAgo'
import { usePageTitle } from './ui/pageTitleContext'
import styles from './TopBar.module.css'

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
  const { data: envelope, loading, error } = useApi<SignalsEnvelope>(SIGNALS_URL, SIGNALS_POLL_MS)
  const { refresh, refreshing } = useRefreshData()
  const { theme, toggleTheme } = useTheme()
  const now = useNow()

  const title = pageTitle ?? routeLabel(location.pathname)
  const signals = envelope?.data ?? null
  const stale = signalsStale(envelope, error !== null)
  const lights = annunciators(signals, { loading, now, stale })
  const pill = attentionPill(signals)
  const observedAt = envelope?.meta?.observedAt ?? null
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
        {lights.map((light) => (
          <li key={light.id}>
            <Link
              to={light.href}
              className={styles.annunciator}
              data-state={light.state}
              aria-label={`${light.label}: ${light.word}`}
              title={`${light.label}: ${light.word}`}
            >
              <span className={styles.annDot} aria-hidden="true" />
              <span className={styles.annName}>{light.label}</span>
              {light.lit && <span className={styles.annWord}>{light.word}</span>}
            </Link>
          </li>
        ))}
      </ul>

      {pill && (
        <Link to="/attention" className={styles.attention} data-state={pill.state}>
          <StatePill state={pill.state} label={pill.text} />
        </Link>
      )}

      <button type="button" className={styles.palette} onClick={onOpenPalette} aria-label="Open command palette">
        <Search size={14} aria-hidden="true" />
        <span className={styles.paletteText}>Search or run…</span>
        <Kbd>{hint}</Kbd>
      </button>

      <div className={styles.age} aria-live="off">
        {stale && (
          <span
            className={styles.stale}
            title={error ? 'The latest read of the shell signals failed; showing the last good reading.' : 'The server is serving an older reading.'}
          >
            <span className={styles.staleDot} aria-hidden="true" />
            <span className={styles.staleText}>Signals stale</span>
          </span>
        )}
        <span className={styles.ageText}>
          {observedAt ? (
            <>
              Updated <TimeAgo value={observedAt} />
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
    </header>
  )
}
