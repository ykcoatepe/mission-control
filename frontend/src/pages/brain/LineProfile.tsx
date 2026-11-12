import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { Block, cx } from '../../components/ui'
import { useNow } from '../../lib/useNow'
import { agoText, type Diagram } from './diagram'
import { fmtCount } from './lib'
import { PROFILE_SCALE_PX, buildProfile, visibleCounts, type ProfileLine } from './profile'
import styles from './LineProfile.module.css'

function describe(line: ProfileLine, now: number): string {
  const pages = line.pages === null ? 'pages not read' : `${fmtCount(line.pages)} pages`
  const chunks = line.chunks === null ? 'chunks not read' : `${fmtCount(line.chunks)} chunks`
  const sync = line.syncOff ? 'sync off' : `last sync ${agoText(line.lastSyncAt, now) ?? 'not read'}`
  return `${line.full}: ${pages}, ${chunks}, ${sync}`
}

/**
 * The line profile: one vertical line per source on a single calibrated baseline, in diagram order.
 * A line's height is its page count on a true linear scale; a source too small to see still gets a
 * one-pixel line and its label. Sync off is dashed. Hover or focus shows the source's own readings.
 */
/** Below this width the profile lies down into rows (see the container query in the stylesheet). */
const WIDE_PX = 900

const countText = (pages: number | null) => (pages === null ? 'not read' : fmtCount(pages))

export function LineProfile({ diagram }: { diagram: Diagram }) {
  const now = useNow()
  const profile = buildProfile(diagram)
  const [active, setActive] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const refs = useRef(new Map<string, HTMLLIElement>())
  const listRef = useRef<HTMLUListElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  useEffect(() => {
    const list = listRef.current
    if (!list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setWidth(list.clientWidth))
    observer.observe(list)
    setWidth(list.clientWidth)
    return () => observer.disconnect()
  }, [profile.lines.length])
  const ids = profile.lines.map((line) => line.id)
  // One tab stop for the whole profile (arrow keys move inside it).
  const stop = focused && ids.includes(focused) ? focused : ids[0]
  // What the pointer is on, else what has focus.
  const shown = profile.lines.find((line) => line.id === (active ?? focused))
  // Standing up (wide), a count that would sit on another is left out of the picture; lying down, every count has its own column.
  const counts = visibleCounts(profile.lines, width !== null && width >= WIDE_PX ? width / Math.max(1, profile.lines.length) : null, countText)

  const onKey = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    const last = ids.length - 1
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? Math.min(last, index + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? Math.max(0, index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null
    if (next === null) return
    event.preventDefault()
    refs.current.get(ids[next])?.focus()
  }

  return (
    <Block
      title="Line profile: pages per source"
      meta={profile.max === null ? 'not read' : `${profile.lines.length} sources`}
      description={
        profile.max === null
          ? undefined
          : `One scale: the tallest line is ${fmtCount(profile.max)} pages. A line too small to see is still drawn, one pixel high.`
      }
    >
      {profile.lines.length === 0 ? (
        <p className={styles.none}>No sources were read.</p>
      ) : (
        <div className={styles.wrap}>
          <ul
            ref={listRef}
            className={styles.profile}
            aria-label="Pages per source"
            style={{ '--scale': `${PROFILE_SCALE_PX}px` } as CSSProperties}
            onMouseLeave={() => setActive(null)}
          >
            {profile.lines.map((line, index) => (
              <li
                key={line.id}
                ref={(el) => {
                  if (el) refs.current.set(line.id, el)
                  else refs.current.delete(line.id)
                }}
                className={cx(styles.item, shown?.id === line.id && styles.shown)}
                data-source-id={line.id}
                data-tone={line.tone}
                data-sync-off={line.syncOff || undefined}
                tabIndex={line.id === stop ? 0 : -1}
                aria-label={describe(line, now)}
                style={
                  {
                    '--h': `${line.height ?? 0}px`,
                    '--p': `${line.percent ?? 0}`,
                  } as CSSProperties
                }
                onMouseEnter={() => setActive(line.id)}
                onFocus={() => {
                  setActive(null)
                  setFocused(line.id)
                }}
                onBlur={() => setFocused((current) => (current === line.id ? null : current))}
                onKeyDown={(event) => onKey(event, index)}
              >
                <span className={styles.plot}>
                  {line.pages !== null && <span className={styles.line} />}
                </span>
                <span className={styles.value} data-crowded={counts.has(line.id) ? undefined : true}>
                  {countText(line.pages)}
                </span>
                <span className={styles.name} title={line.full}>
                  {line.name}
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.readout} aria-live="polite">
            {shown ? describe(shown, now) : 'Hover or focus a line for its readings.'}
          </p>
        </div>
      )}
    </Block>
  )
}
