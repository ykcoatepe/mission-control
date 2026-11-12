import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { Block, cx } from '../../components/ui'
import { formatAsOf } from '../../components/ui/asOf'
import { stateLabel } from '../../lib/state'
import { useNow } from '../../lib/useNow'
import { agoText, type Diagram } from './diagram'
import { fmtCount } from './lib'
import { PROFILE_SCALE_PX, axisTicks, shareOf, buildProfile, staggerRows, visibleCounts, type ProfileLine } from './profile'
import styles from './LineProfile.module.css'

function describe(line: ProfileLine, now: number): string {
  const pages = line.pages === null ? 'pages not read' : `${fmtCount(line.pages)} pages`
  const chunks = line.chunks === null ? 'chunks not read' : `${fmtCount(line.chunks)} chunks`
  const sync = line.syncOff ? 'sync off' : `last sync ${agoText(line.lastSyncAt, now) ?? 'not read'}`
  return `${line.full}: ${pages}, ${chunks}, ${sync}`
}

/** What the source's sync is: sync off, fresh, or the state word. */
function syncState(line: ProfileLine): string {
  if (line.syncOff) return 'sync off'
  return line.state === 'healthy' ? 'fresh' : stateLabel(line.state).toLowerCase()
}

/** Below this width the profile lies down into rows (see the container query in the stylesheet). */
const WIDE_PX = 900

const countText = (pages: number | null) => (pages === null ? 'not read' : fmtCount(pages))

/**
 * The line profile: one vertical line per source on a single calibrated baseline, in diagram order, with a
 * labelled scale on the left. A line's height is its page count on a true linear scale; a source too
 * small to see still gets a one-pixel line and its label. Sync off is dashed. Hovering a column (all of it,
 * from the top of the plot to the label), focusing it, or tapping it shows that source large: its line
 * thickens, the others dim, a hairline runs from the line's top to the scale, and a readout gives its numbers.
 */
export function LineProfile({ diagram }: { diagram: Diagram }) {
  const now = useNow()
  const profile = buildProfile(diagram)
  const [hovered, setHovered] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const refs = useRef(new Map<string, HTMLLIElement>())
  const listRef = useRef<HTMLUListElement | null>(null)
  const pointer = useRef<string>('mouse')
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
  const total = Math.max(1, ids.length)
  // One tab stop for the whole profile (arrow keys move inside it).
  const stop = focused && ids.includes(focused) ? focused : ids[0]
  // What the pointer is on, else what was tapped, else what has focus. Escape puts it away until the next move.
  const shownId = dismissed ? null : (hovered ?? pinned ?? focused)
  const shownIndex = profile.lines.findIndex((line) => line.id === shownId)
  const shown = shownIndex >= 0 ? profile.lines[shownIndex] : undefined
  const wide = width !== null && width >= WIDE_PX
  const column = wide ? width / total : null
  // Standing up (wide), a count that would sit on another is left out of the picture; lying down, every count has its own column.
  const counts = visibleCounts(profile.lines, column, countText)
  const rows = staggerRows(profile.lines.map((line) => line.name), column)
  const ticks = axisTicks(profile.max)

  const clear = () => {
    setHovered(null)
    setPinned(null)
    setDismissed(true)
  }

  const onKey = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      clear()
      return
    }
    const last = ids.length - 1
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? Math.min(last, index + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? Math.max(0, index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null
    if (next === null) return
    event.preventDefault()
    setDismissed(false)
    refs.current.get(ids[next])?.focus()
  }

  const position = shownIndex < 0 ? 0 : (shownIndex + 0.5) / total
  const align = shownIndex < 0 ? 'centre' : position < 0.18 ? 'start' : position > 0.82 ? 'end' : 'centre'

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
          <div className={styles.chart} style={{ '--scale': `${PROFILE_SCALE_PX}px` } as CSSProperties}>
            <div className={styles.axis} aria-hidden="true" data-axis>
              {ticks.map((value) => (
                <span key={value} className={styles.tick} data-tick={value} style={{ '--v': `${((value / (profile.max ?? 1)) * PROFILE_SCALE_PX).toFixed(1)}px` } as CSSProperties}>
                  {fmtCount(value)}
                </span>
              ))}
            </div>
            <div className={styles.body}>
              <ul
                ref={listRef}
                className={styles.profile}
                aria-label="Pages per source"
                style={{ '--scale': `${PROFILE_SCALE_PX}px` } as CSSProperties}
                data-focus={shown ? true : undefined}
                onMouseLeave={() => setHovered(null)}
              >
                {profile.lines.map((line, index) => {
                  const isShown = shown?.id === line.id
                  return (
                    <li
                      key={line.id}
                      ref={(el) => {
                        if (el) refs.current.set(line.id, el)
                        else refs.current.delete(line.id)
                      }}
                      className={cx(styles.item, isShown && styles.shown)}
                      data-source-id={line.id}
                      data-tone={line.tone}
                      data-sync-off={line.syncOff || undefined}
                      data-shown={isShown || undefined}
                      tabIndex={line.id === stop ? 0 : -1}
                      aria-label={describe(line, now)}
                      style={
                        {
                          '--h': `${line.height ?? 0}px`,
                          '--p': `${line.percent ?? 0}`,
                          '--row': rows[index],
                        } as CSSProperties
                      }
                      onPointerDown={(event) => {
                        pointer.current = event.pointerType || 'mouse'
                      }}
                      onMouseEnter={() => {
                        if (pointer.current === 'touch') return
                        setDismissed(false)
                        setHovered(line.id)
                      }}
                      onClick={() => {
                        // A tap toggles the same state a hover shows.
                        if (pointer.current !== 'touch') return
                        setDismissed(false)
                        setPinned((current) => (current === line.id ? null : line.id))
                      }}
                      onFocus={() => {
                        setHovered(null)
                        setDismissed(false)
                        setFocused(line.id)
                      }}
                      onBlur={() => {
                        setFocused((current) => (current === line.id ? null : current))
                        setPinned((current) => (current === line.id ? null : current))
                      }}
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
                      {isShown && (
                        <span className={styles.full} data-align={align} data-full-label>
                          {line.full}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
              {shown && (
                <>
                  {shown.height !== null && (
                    <span
                      className={styles.rule}
                      data-rule
                      aria-hidden="true"
                      style={{ '--h': `${shown.height}px`, '--x': `${position * 100}%` } as CSSProperties}
                    />
                  )}
                  <div
                    className={styles.card}
                    data-readout
                    data-side={position < 0.5 ? 'right' : 'left'}
                    aria-hidden="true"
                    style={{ '--x': `${position * 100}%` } as CSSProperties}
                  >
                    <p className={styles.cardTitle}>
                      {shown.full} <span className={styles.cardGroup}>{shown.groupLabel}</span>
                    </p>
                    <dl className={styles.cardList}>
                      <dt>Pages</dt>
                      <dd>{countText(shown.pages)}</dd>
                      <dt>Chunks</dt>
                      <dd>{countText(shown.chunks)}</dd>
                      <dt>Share of all pages</dt>
                      <dd>{shareOf(shown)}</dd>
                      <dt>Last sync</dt>
                      <dd>
                        {formatAsOf(shown.lastSyncAt, now)?.replace(/^as of /, '') ?? 'not read'}
                        {agoText(shown.lastSyncAt, now) ? ` (${agoText(shown.lastSyncAt, now)})` : ''}
                      </dd>
                      <dt>Sync</dt>
                      <dd>{syncState(shown)}</dd>
                    </dl>
                  </div>
                </>
              )}
            </div>
          </div>
          <p className={styles.readout} aria-live="polite">
            {shown ? describe(shown, now) : 'Hover or focus a line for its readings.'}
          </p>
        </div>
      )}
    </Block>
  )
}
