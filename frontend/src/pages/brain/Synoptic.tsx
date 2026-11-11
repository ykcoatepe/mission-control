import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { Mono, StateDot, cx } from '../../components/ui'
import { stateLabel } from '../../lib/state'
import { CORE_ID, QUEUE_ID, edgeId, type BlockModel, type BrainModel, type EdgeModel } from './lib'
import {
  MIN_WIDTH,
  arrowData,
  computeSynopticLayout,
  moveFocus,
  pathData,
  truncateLabel,
  type Box,
  type Direction,
} from './synopticLayout'
import styles from './Synoptic.module.css'

const DEFAULT_WIDTH = 960
const ARROW_KEYS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const el = ref.current
      if (!el || typeof ResizeObserver === 'undefined') return () => undefined
      const observer = new ResizeObserver(onChange)
      observer.observe(el)
      return () => observer.disconnect()
    },
    [ref],
  )
  return useSyncExternalStore(
    subscribe,
    () => ref.current?.clientWidth ?? 0,
    () => 0,
  )
}

export interface SynopticProps {
  model: BrainModel
  selectedId: string | null
  onSelect: (id: string) => void
}

const accessibleName = (block: BlockModel) => `${block.label}: ${stateLabel(block.state).toLowerCase()}, ${block.sub}`

/** Dark-cockpit schematic: readers -> core <- sources, queue under the core. Falls back to a list when narrow. */
export function Synoptic({ model, selectedId, onSelect }: SynopticProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const measured = useElementWidth(wrapRef)
  const width = measured || DEFAULT_WIDTH
  return (
    <div ref={wrapRef} className={styles.wrap}>
      {width >= MIN_WIDTH ? (
        <SynopticMap model={model} width={width} selectedId={selectedId} onSelect={onSelect} />
      ) : (
        <SynopticList model={model} selectedId={selectedId} onSelect={onSelect} />
      )}
      <ul className={styles.legend} aria-label="Legend">
        <li>
          <StateDot state="healthy" /> Normal
        </li>
        <li>
          <StateDot state="warning" /> Needs attention
        </li>
        <li>
          <StateDot state="unavailable" /> Not read
        </li>
        <li>
          <StateDot state="inactive" /> Switched off
        </li>
      </ul>
    </div>
  )
}

function SynopticMap({ model, width, selectedId, onSelect }: SynopticProps & { width: number }) {
  const mapRef = useRef<HTMLDivElement>(null)
  // Two roving groups, each one Tab stop: the blocks, then the lines.
  const [focusId, setFocusId] = useState<string>(CORE_ID)
  const [edgeFocusId, setEdgeFocusId] = useState<string>(edgeId(QUEUE_ID))
  const layout = computeSynopticLayout({
    width,
    readerIds: model.readers.map((r) => r.id),
    groupIds: model.groups.map((g) => g.id),
    queueId: QUEUE_ID,
  })
  const edgeByBlock = new Map(model.edges.map((e) => [e.blockId, e]))

  type Placed = { block: BlockModel; box: Box }
  const placed: Placed[] = [
    ...model.readers.map((block, i) => ({ block, box: layout.readers[i].box })),
    { block: model.core, box: layout.core },
    ...model.groups.map((block, i) => ({ block, box: layout.groups[i].box })),
    { block: model.queue, box: layout.queue },
  ]
  const edgesPlaced = layout.edges.flatMap((le) => {
    const edge = edgeByBlock.get(le.blockId)
    return edge ? [{ edge, le }] : []
  })

  const blockItems = placed.map(({ block, box }) => ({ id: block.id, x: box.x + box.w / 2, y: box.y + box.h / 2 }))
  const edgeItems = edgesPlaced.map(({ edge, le }) => ({
    id: edge.id,
    x: le.label.align === 'end' ? le.label.x - le.label.maxWidth / 2 : le.label.x + le.label.maxWidth / 2,
    y: le.label.y + 8,
  }))
  const rovingId = blockItems.some((f) => f.id === focusId) ? focusId : CORE_ID
  const edgeRovingId = edgeItems.some((f) => f.id === edgeFocusId) ? edgeFocusId : (edgeItems[0]?.id ?? '')

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = ARROW_KEYS[event.key]
    if (!direction) return
    const current = (event.target as HTMLElement).getAttribute?.('data-syn-id') ?? ''
    const onEdge = current.startsWith('edge:')
    const next = moveFocus(onEdge ? edgeItems : blockItems, onEdge ? edgeRovingId : rovingId, direction)
    event.preventDefault()
    if (!next) return
    if (onEdge) setEdgeFocusId(next)
    else setFocusId(next)
    mapRef.current?.querySelector<HTMLElement>(`[data-syn-id="${CSS.escape(next)}"]`)?.focus()
  }

  return (
    <div
      ref={mapRef}
      className={styles.map}
      style={{ width: layout.width, height: layout.height }}
      role="group"
      aria-label="System synoptic. Arrow keys move between blocks; Tab then moves to the lines."
      onKeyDown={onKeyDown}
    >
      <svg className={styles.lines} width={layout.width} height={layout.height} aria-hidden="true">
        {edgesPlaced.map(({ edge, le }) => (
          <g
            key={edge.id}
            className={styles.edge}
            data-state={edge.state}
            data-selected={selectedId === edge.id || undefined}
          >
            <path className={styles.line} d={pathData(le.points)} />
            <path className={styles.arrow} d={arrowData(le.arrow)} />
            <path className={styles.hit} d={pathData(le.points)} onClick={() => onSelect(edge.id)} />
          </g>
        ))}
      </svg>

      {layout.headers.map((h) => (
        <span key={h.id} className={styles.columnHeader} style={{ left: h.x, top: h.y }}>
          {h.id === 'readers' ? 'Readers' : h.id === 'core' ? 'GBrain core' : 'Sources'}
        </span>
      ))}

      {placed.map(({ block, box }) => (
        <BlockButton
          key={block.id}
          block={block}
          box={box}
          core={block.id === CORE_ID ? model.core.rows : undefined}
          selected={selectedId === block.id}
          tabIndex={rovingId === block.id ? 0 : -1}
          onFocus={() => setFocusId(block.id)}
          onSelect={() => onSelect(block.id)}
        />
      ))}

      {edgesPlaced.map(({ edge, le }) => (
        <EdgeButton
          key={edge.id}
          edge={edge}
          anchor={le.label}
          selected={selectedId === edge.id}
          tabIndex={edgeRovingId === edge.id ? 0 : -1}
          onFocus={() => setEdgeFocusId(edge.id)}
          onSelect={() => onSelect(edge.id)}
        />
      ))}
    </div>
  )
}

function BlockButton({
  block,
  box,
  core,
  selected,
  tabIndex,
  onFocus,
  onSelect,
}: {
  block: BlockModel
  box: Box
  core?: Array<{ label: string; value: string }>
  selected: boolean
  tabIndex: number
  onFocus: () => void
  onSelect: () => void
}) {
  const nameChars = Math.floor((box.w - 52 - (block.count !== null ? 32 : 0)) / 7)
  const name = truncateLabel(block.label, nameChars)
  const sub = truncateLabel(block.sub, Math.floor((box.w - 24) / 6.4))
  return (
    <button
      type="button"
      className={cx(styles.block, core && styles.coreBlock)}
      data-state={block.state}
      data-kind={block.kind}
      data-syn-id={block.id}
      data-selected={selected || undefined}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      aria-label={accessibleName(block)}
      aria-pressed={selected}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={onSelect}
    >
      <span className={styles.blockTitle}>
        <StateDot state={block.state} />
        <span className={styles.name} title={name.truncated ? name.full : undefined}>
          {name.text}
        </span>
        {block.count !== null && <Mono className={styles.count}>{block.count}</Mono>}
      </span>
      <span className={styles.blockSub} title={sub.truncated ? sub.full : undefined}>
        {sub.text}
      </span>
      {core && (
        <dl className={styles.coreRows}>
          {core.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>
                <Mono>{row.value}</Mono>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </button>
  )
}

function EdgeButton({
  edge,
  anchor,
  selected,
  tabIndex,
  onFocus,
  onSelect,
}: {
  edge: EdgeModel
  anchor: { x: number; y: number; align: 'start' | 'end' | 'center'; maxWidth: number }
  selected: boolean
  tabIndex: number
  onFocus: () => void
  onSelect: () => void
}) {
  const label = truncateLabel(edge.label, Math.floor(anchor.maxWidth / 6.6))
  return (
    <button
      type="button"
      className={cx(styles.edgeLabel, anchor.align === 'end' && styles.edgeLabelEnd)}
      data-state={edge.state}
      data-syn-id={edge.id}
      data-selected={selected || undefined}
      style={{ left: anchor.x, top: anchor.y, maxWidth: anchor.maxWidth }}
      aria-label={edge.title}
      aria-pressed={selected}
      title={label.truncated ? label.full : undefined}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onClick={onSelect}
    >
      {label.text}
    </button>
  )
}

/** Under the width limit: the same states and the same selection, as a plain grouped list. */
function SynopticList({ model, selectedId, onSelect }: Omit<SynopticProps, 'width'>) {
  const lineFor = (blockId: string) => model.edges.find((e) => e.id === edgeId(blockId))
  const section = (title: string, blocks: BlockModel[]) =>
    blocks.length === 0 ? null : (
      <section className={styles.listSection} aria-label={title}>
        <h3 className={styles.listTitle}>{title}</h3>
        <ul>
          {blocks.map((block) => {
            const line = lineFor(block.id)
            return (
              <li key={block.id}>
                <button
                  type="button"
                  className={styles.listRow}
                  data-state={block.state}
                  data-selected={selectedId === block.id || undefined}
                  aria-pressed={selectedId === block.id}
                  aria-label={accessibleName(block)}
                  onClick={() => onSelect(block.id)}
                >
                  <StateDot state={block.state} />
                  <span className={styles.listName}>{block.label}</span>
                  {block.count !== null && <Mono muted>{block.count}</Mono>}
                  <span className={styles.listSub}>{block.sub}</span>
                  {line && block.kind !== 'core' && line.label !== block.sub && (
                    <Mono muted className={styles.listLine}>
                      {line.label}
                    </Mono>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    )
  return (
    <div className={styles.list}>
      {section('Readers', model.readers)}
      {section('GBrain core', [model.core])}
      {section('Sources', model.groups)}
      {section('Embedding queue', [model.queue])}
    </div>
  )
}
