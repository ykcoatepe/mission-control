import { Menu, Moon, RefreshCw, Search, Sun } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useApi } from '../lib/hooks'
import { SIGNALS_POLL_MS, SIGNALS_URL, annunciators, attentionPill, signalsStale } from '../lib/signals'
import type { Annunciator, SignalsEnvelope } from '../lib/signals'
import { worstState } from '../lib/state'
import type { UiState } from '../lib/state'
import { useNow } from '../lib/useNow'
import { useRefreshData } from '../lib/useRefreshData'
import { useTheme } from '../lib/theme'
import { appRoutes, isLiveRoutePath } from '../appRoutes'
import { Kbd } from './ui/Kbd'
import { IconButton } from './ui/IconButton'
import { StateDot } from './ui/StateDot'
import { TimeAgo } from './ui/TimeAgo'
import { usePageTitle } from './ui/pageTitleContext'
import styles from './TopBar.module.css'

interface TopBarProps {
  onOpenMenu: () => void
  onOpenPalette: () => void
  /** The off-canvas navigation is open (for `aria-expanded` on the menu button). */
  menuExpanded?: boolean
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

/** "OpenClaw: warning. OpenClaw status evidence is unavailable." The server's reason is the tooltip. */
function annunciatorText(light: Annunciator): string {
  return light.reason ? `${light.label}: ${light.word}. ${light.reason}` : `${light.label}: ${light.word}`
}

/** One light for all three systems: the worst lit state, or "reading" until the first load completes. */
function overallState(lights: Annunciator[]): UiState | 'reading' {
  if (lights.some((light) => light.state === 'reading')) return 'reading'
  return worstState(lights.map((light) => light.state as UiState))
}

/**
 * On narrow screens the three annunciators collapse into one status button that
 * opens a small list, so the page title keeps the room. Esc and a click outside
 * close it; the links go to the same places as the inline annunciators.
 */
function SystemsMenu({ lights }: { lights: Annunciator[] }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const overall = overallState(lights)
  const summary = lights.map((light) => `${light.label} ${light.word}`).join(', ')

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className={styles.systemsMenu}>
      <button
        ref={buttonRef}
        type="button"
        className={`${styles.annunciator} ${styles.systemsButton}`}
        data-state={overall}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Systems: ${summary}`}
        title={`Systems: ${summary}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.annDot} aria-hidden="true" />
      </button>
      {open && (
        <ul id={listId} className={styles.systemsList} aria-label="Systems">
          {lights.map((light) => (
            <li key={light.id}>
              <Link
                to={light.href}
                className={styles.systemsItem}
                data-state={light.state}
                title={annunciatorText(light)}
                aria-label={annunciatorText(light)}
                onClick={() => setOpen(false)}
              >
                <span className={styles.annDot} aria-hidden="true" />
                <span>{light.label}</span>
                <span className={styles.systemsWord}>{light.word}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function TopBar({ onOpenMenu, onOpenPalette, menuExpanded = false }: TopBarProps) {
  const location = useLocation()
  const pageTitle = usePageTitle()
  const { data: envelope, loading, error } = useApi<SignalsEnvelope>(SIGNALS_URL, SIGNALS_POLL_MS)
  const { refresh, refreshing } = useRefreshData()
  const { theme, toggleTheme } = useTheme()
  const now = useNow()

  const title = pageTitle ?? routeLabel(location.pathname)
  const signals = envelope?.data ?? null
  const stale = signalsStale(envelope, error !== null)
  const lights = annunciators(signals, { loading, now, stale, isLivePath: isLiveRoutePath })
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
        aria-expanded={menuExpanded}
        data-nav-menu=""
        onClick={onOpenMenu}
      />
      <h1 className={styles.title} title={title}>
        {title}
      </h1>

      <div className={styles.spacer} />

      <SystemsMenu lights={lights} />

      <ul className={styles.annunciators} aria-label="Systems">
        {lights.map((light) => (
          <li key={light.id}>
            <Link
              to={light.href}
              className={styles.annunciator}
              data-state={light.state}
              aria-label={annunciatorText(light)}
              title={annunciatorText(light)}
            >
              <span className={styles.annDot} aria-hidden="true" />
              <span className={styles.annName}>{light.label}</span>
              {light.lit && <span className={styles.annWord}>{light.word}</span>}
            </Link>
          </li>
        ))}
      </ul>

      {pill && (
        <Link
          to="/attention"
          className={styles.attention}
          data-state={pill.state}
          aria-label={pill.secondary ? `${pill.text}, ${pill.secondary}` : pill.text}
          title={pill.secondary ? `${pill.text} · ${pill.secondary}` : pill.text}
        >
          <StateDot state={pill.state} />
          <span className={styles.attentionCount}>{pill.count}</span>
          <span className={styles.attentionWords}>{pill.text.replace(/^\d+\s+/, '')}</span>
          {pill.secondary && <span className={styles.attentionSecondary}>{pill.secondary}</span>}
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
