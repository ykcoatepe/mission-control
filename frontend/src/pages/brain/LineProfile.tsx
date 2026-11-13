import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { Block, cx } from '../../components/ui'
import { stateLabel } from '../../lib/state'
import { useNow } from '../../lib/useNow'
import { agoText, type Diagram } from './diagram'
import { fmtCount } from './lib'
import {
  PROFILE_SCALE_PX,
  axisTicks,
  buildProfile,
  coveredLabels,
  crowdedTicks,
  shareOf,
  visibleCounts,
  visibleLabels,
  type ProfileLine,
} from './profile'
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

const NONE: ReadonlySet<string> = new Set()

/** One source's readings on a single line, in the caption row: name in its group colour, then the numbers. */
function Reading({ line, now }: { line: ProfileLine; now: number }) {
  const sync = line.syncOff
    ? [syncState(line)]
    : [`last sync ${agoText(line.lastSyncAt, now) ?? 'not read'}`, syncState(line)]
  const parts = [
    line.groupLabel,
    line.pages === null ? 'pages not read' : `${fmtCount(line.pages)} pages`,
    line.chunks === null ? 'chunks not read' : `${fmtCount(line.chunks)} chunks`,
    line.share === null ? 'share not read' : `${shareOf(line)} of all pages`,
    ...sync,
  ]
  return (
    <span className={styles.reading} data-readout data-tone={line.tone}>
      <span className={styles.readingName}>{line.full}</span>
      {parts.map((part) => (
        <span key={part} className={styles.readingPart}>
          {part}
        </span>
      ))}
    </span>
  )
}

/**
 * The line profile: one vertical line per source on a single calibrated baseline, in diagram order, with a
 * labelled scale on the left. A line's height is its page count on a true linear scale; a source too
 * small to see still gets a one-pixel line and its label. Sync off is dashed. Hovering a column (all of it,
 * from the top of the plot to the label), focusing it, or tapping it shows that source large: its line
 * thickens, the others dim, its exact value is marked on the scale (nothing crosses the plot), and its
 * readings replace the sentence under the block title. The readout has one fixed home and covers no data.
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
  // Measured, not guessed: the width of each label, and which labels sit under the looked-at source's enlarged one.
  const [nameWidths, setNameWidths] = useState<Record<string, number>>({})
  const [covered, setCovered] = useState<ReadonlySet<string>>(NONE)
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
  // One row of labels: a label that would touch a bigger source's label is left out (its name is in the readout and the accessible name).
  const labelled = visibleLabels(profile.lines, column, nameWidths)
  const ticks = axisTicks(profile.max)
  const shownHeight = shown?.pages === null ? null : (shown?.height ?? null)
  const crowdedTick = crowdedTicks(ticks, profile.max, shownHeight)
  const nameKey = profile.lines.map((line) => `${line.id}=${line.name}`).join('|')

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !wide) {
      setNameWidths((current) => (Object.keys(current).length ? {} : current))
      return
    }
    const measure = () => {
      const next: Record<string, number> = {}
      for (const el of list.querySelectorAll<HTMLElement>('[data-name-label]')) {
        const id = el.closest('li')?.getAttribute('data-source-id')
        const w = el.getBoundingClientRect().width
        if (id && w > 0) next[id] = Math.ceil(w)
      }
      setNameWidths((current) => {
        const same = Object.keys(next).length === Object.keys(current).length && Object.entries(next).every(([id, w]) => current[id] === w)
        return same ? current : next
      })
    }
    measure()
    // Labels change width when the web font arrives.
    let live = true
    void document.fonts?.ready.then(() => live && measure())
    return () => {
      live = false
    }
  }, [wide, nameKey])

  useLayoutEffect(() => {
    const list = listRef.current
    const full = list?.querySelector<HTMLElement>('[data-full-label]')
    if (!list || !full || !wide) {
      setCovered((current) => (current.size ? NONE : current))
      return
    }
    const cover = full.getBoundingClientRect()
    const labels = [...list.querySelectorAll<HTMLElement>('[data-name-label]')].flatMap((el) => {
      const li = el.closest('li')
      const id = li?.getAttribute('data-source-id')
      if (!id || id === shownId) return []
      const box = el.getBoundingClientRect()
      return [{ id, box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom } }]
    })
    const next = coveredLabels({ left: cover.left, right: cover.right, top: cover.top, bottom: cover.bottom }, labels)
    setCovered((current) => (current.size === next.size && [...next].every((id) => current.has(id)) ? current : next))
  }, [shownId, wide, nameKey, nameWidths])

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
  // The enlarged label stays inside the strip: flush left or right near an edge.
  const align = shownIndex < 0 ? 'centre' : position < 0.18 ? 'start' : position > 0.82 ? 'end' : 'centre'

  return (
    <Block
      title="Line profile: pages per source"
      meta={profile.max === null ? 'not read' : `${profile.lines.length} sources`}
      description={
        profile.lines.length === 0 ? undefined : (
          <span className={styles.caption} data-caption>
            <span className={styles.idle} data-caption-idle data-away={shown ? true : undefined}>
              {profile.max === null
                ? 'The pages of the sources were not read, so no line is drawn.'
                : `One scale: the tallest line is ${fmtCount(profile.max)} pages. A line too small to see is still drawn, one pixel high.`}
            </span>
            {shown && <Reading line={shown} now={now} />}
          </span>
        )
      }
    >
      {profile.lines.length === 0 ? (
        <p className={styles.none}>No sources were read.</p>
      ) : (
        <div className={styles.wrap}>
          <div className={styles.chart} style={{ '--scale': `${PROFILE_SCALE_PX}px` } as CSSProperties}>
            <div className={styles.axis} aria-hidden="true" data-axis>
              {ticks.map((value) => (
                <span
                  key={value}
                  className={styles.tick}
                  data-tick={value}
                  data-away={crowdedTick.has(value) ? true : undefined}
                  style={{ '--v': `${((value / (profile.max ?? 1)) * PROFILE_SCALE_PX).toFixed(1)}px` } as CSSProperties}
                >
                  {fmtCount(value)}
                </span>
              ))}
              {shown && shown.pages !== null && shownHeight !== null && (
                <span className={cx(styles.tick, styles.marker)} data-axis-marker style={{ '--v': `${shownHeight}px` } as CSSProperties}>
                  {fmtCount(shown.pages)}
                </span>
              )}
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
                      <span
                        className={styles.name}
                        title={line.full}
                        data-name-label
                        data-dropped={labelled.has(line.id) ? undefined : true}
                        data-covered={covered.has(line.id) ? true : undefined}
                      >
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
            </div>
          </div>
          {/* The same readings, for screen readers: the caption row is the visible home. */}
          <p className="visually-hidden" aria-live="polite" data-live>
            {shown ? describe(shown, now) : ''}
          </p>
        </div>
      )}
    </Block>
  )
}
