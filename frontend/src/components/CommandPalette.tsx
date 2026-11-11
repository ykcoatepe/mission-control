import { useQuery } from '@tanstack/react-query'
import { Bot, CornerDownLeft, RefreshCw, Search, SunMoon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { apiQueryOptions } from '../lib/hooks'
import { toggleTheme } from '../lib/theme'
import { useNavigation } from '../lib/useNavigation'
import { useRefreshData } from '../lib/useRefreshData'
import type { CronApiResponse } from '../pages/cron/types'
import { rankEntries } from './commandPaletteLib'
import type { PaletteEntry } from './commandPaletteLib'
import { Kbd } from './ui/Kbd'
import { cx } from './ui/cx'
import { useModal } from './ui/useModal'
import styles from './CommandPalette.module.css'

const CAP = 8

interface SessionsPayload {
  sessions?: Array<{ key?: string; displayName?: string; label?: string }>
}

interface Entry extends PaletteEntry {
  icon?: LucideIcon
  run: () => void
}

interface Section {
  key: string
  title: string
  entries: Entry[]
}

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** ⌘K / Ctrl+K opens the palette from anywhere in the shell. */
export default function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        onOpenChange(!open)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  if (!open) return null
  return createPortal(<PaletteBody onClose={() => onOpenChange(false)} />, document.body)
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { primary, utility } = useNavigation()
  const { refresh } = useRefreshData()
  // Automations and sessions are only fetched while the palette is open (it unmounts when closed).
  const { data: cron } = useQuery(apiQueryOptions<CronApiResponse>('/api/cron'))
  const { data: sessions } = useQuery(apiQueryOptions<SessionsPayload>('/api/sessions'))

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const baseId = useId()
  useModal(true, onClose, panelRef)

  const pages = useMemo<Entry[]>(
    () =>
      [...primary, ...utility].map((route) => ({
        id: `page:${route.path}`,
        label: route.label,
        subtitle: route.description,
        icon: route.icon,
        run: () => navigate(route.path),
      })),
    [primary, utility, navigate],
  )

  const automations = useMemo<Entry[]>(
    () =>
      (cron?.jobs ?? []).map((job) => ({
        id: `job:${job.id}`,
        label: job.name || job.id,
        subtitle: job.schedule,
        run: () => navigate(`/automations?job=${encodeURIComponent(job.id)}`),
      })),
    [cron, navigate],
  )

  const sessionEntries = useMemo<Entry[]>(
    () =>
      (sessions?.sessions ?? [])
        .filter((session) => session.key)
        .map((session) => ({
          id: `session:${session.key}`,
          label: session.displayName || session.label || String(session.key),
          subtitle: session.label && session.label !== session.displayName ? session.label : undefined,
          run: () => navigate(`/sessions?session=${encodeURIComponent(String(session.key))}`),
        })),
    [sessions, navigate],
  )

  const commands = useMemo<Entry[]>(
    () => [
      { id: 'cmd:refresh', label: 'Refresh data', subtitle: 'Read everything on screen again', icon: RefreshCw, run: refresh },
      { id: 'cmd:theme', label: 'Toggle theme', subtitle: 'Switch between dark and light', icon: SunMoon, run: toggleTheme },
      {
        id: 'cmd:assistant',
        label: 'Open assistant',
        subtitle: 'Ask the assistant',
        icon: Bot,
        run: () => window.dispatchEvent(new CustomEvent('open-chat')),
      },
    ],
    [refresh],
  )

  const searching = query.trim().length > 0
  const sections = useMemo<Section[]>(() => {
    const all: Section[] = [
      { key: 'pages', title: 'Pages', entries: searching ? rankEntries(query, pages, CAP) : pages },
      { key: 'automations', title: 'Automations', entries: searching ? rankEntries(query, automations, CAP) : [] },
      { key: 'sessions', title: 'Sessions', entries: searching ? rankEntries(query, sessionEntries, CAP) : [] },
      { key: 'commands', title: 'Commands', entries: rankEntries(query, commands, CAP) },
    ]
    return all.filter((section) => section.entries.length > 0)
  }, [query, searching, pages, automations, sessionEntries, commands])

  const flat = useMemo(() => sections.flatMap((section) => section.entries), [sections])
  const indexById = useMemo(() => new Map(flat.map((entry, index) => [entry.id, index])), [flat])
  const active = Math.min(activeIndex, Math.max(0, flat.length - 1))
  const optionId = (entry: Entry) => `${baseId}-${entry.id}`

  useEffect(() => {
    const entry = flat[active]
    if (!entry) return
    document.getElementById(`${baseId}-${entry.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, flat, baseId])

  const choose = (entry: Entry) => {
    onClose()
    entry.run()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (flat.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((active + step + flat.length) % flat.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const entry = flat[active]
      if (entry) choose(entry)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Command palette" tabIndex={-1} className={styles.panel}>
        <div className={styles.inputRow}>
          <Search size={16} className={styles.inputIcon} aria-hidden="true" />
          <input
            data-autofocus
            className={styles.input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${baseId}-list`}
            aria-activedescendant={flat[active] ? optionId(flat[active]) : undefined}
            aria-autocomplete="list"
            aria-label="Search pages, automations and sessions, or run a command"
            placeholder="Search pages, automations, sessions or commands…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={onKeyDown}
          />
        </div>

        <div id={`${baseId}-list`} role="listbox" aria-label="Results" className={styles.list}>
          {flat.length === 0 && <p className={styles.none}>No matches for “{query.trim()}”.</p>}
          {sections.map((section) => (
            <div key={section.key} role="group" aria-label={section.title}>
                <p className={styles.sectionTitle} aria-hidden="true">
                  {section.title}
                </p>
                {section.entries.map((entry) => {
                  const index = indexById.get(entry.id) ?? 0
                  const selected = index === active
                  const Icon = entry.icon
                  return (
                    <div
                      key={entry.id}
                      id={optionId(entry)}
                      role="option"
                      aria-selected={selected}
                      className={cx(styles.option, selected && styles.optionActive)}
                      onMouseMove={() => {
                        if (index !== active) setActiveIndex(index)
                      }}
                      onClick={() => choose(entry)}
                    >
                      {Icon ? <Icon size={14} className={styles.optionIcon} aria-hidden="true" /> : <span className={styles.optionIcon} />}
                      <span className={styles.optionLabel}>{entry.label}</span>
                      {entry.subtitle && <span className={styles.optionSubtitle}>{entry.subtitle}</span>}
                      {selected && <CornerDownLeft size={12} className={styles.enter} aria-hidden="true" />}
                    </div>
                  )
                })}
            </div>
          ))}
        </div>

        <div className={styles.footer} aria-hidden="true">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>esc</Kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
