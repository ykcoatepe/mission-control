import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Block, Button, StateMark, cx } from '../../components/ui'
import { stateLabel, type UiState } from '../../lib/state'
import { useNow } from '../../lib/useNow'
import { coreReadings, embeddedPercent, fmtPercent, type CoreReading, type Diagram, type DiagramGroup } from './diagram'
import { CORE_ID, QUEUE_ID, fmtCount, type BlockModel, type BrainModel } from './lib'
import {
  GROUP_HEADER_H,
  GROUP_ROW_H,
  READER_W,
  computeTrackLayout,
  moveFocus,
  trackPath,
  truncateLabel,
  wrapWords,
  type Box,
  type Direction,
} from './trackLayout'
import type { GBrainSynoptic, HealthReading } from './types'
import styles from './TrackDiagram.module.css'

const ARROWS: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

/** Said once, under the readers, wherever a reader is set up. */
export const READERS_CAPTION = "Live connections can't be read from this machine."

const NAME_CHARS = 24

export interface TrackDiagramProps {
  syn: GBrainSynoptic
  model: BrainModel
  diagram: Diagram
  health: HealthReading | null | undefined
  selectedId: string | null
  onSelect: (id: string) => void
}

const num = (value: number | null | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** State words are written for people: lower case in a sentence. */
const word = (state: UiState) => stateLabel(state).toLowerCase()

/** The mark of a state, placed inside the SVG. */
function Mark({ state, x, y }: { state: UiState; x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} aria-hidden="true">
      <StateMark state={state} />
    </g>
  )
}

const pagesTotal = (total: number | null) => (total === null ? 'not read' : `${fmtCount(total)} ${total === 1 ? 'page' : 'pages'}`)

const pagesText = (pages: number | null) => (pages === null ? 'not read' : fmtCount(pages))

function groupLabel(group: DiagramGroup) {
  const total = group.totalPages
  const pages = total === null ? 'pages not read' : `${fmtCount(total)} pages`
  return `${group.label}, ${group.sources.length} ${group.sources.length === 1 ? 'source' : 'sources'}, ${pages}`
}

function readerSub(reader: BlockModel): string {
  return reader.sub.toLowerCase()
}

export function TrackDiagram({ syn, model, diagram, health, selectedId, onSelect }: TrackDiagramProps) {
  const now = useNow()
  const readings = coreReadings(syn, diagram, health, now)
  const percent = embeddedPercent(syn.core)
  const waiting = num(syn.queue.waiting?.value)
  const active = num(syn.queue.active?.value)
  const stalled = num(syn.queue.stalled?.value)
  const queueRead = waiting !== null
  const layout = computeTrackLayout({
    groupRows: diagram.groups.map((group) => group.sources.length),
    readerCount: model.readers.length,
    queueUnits: queueRead ? waiting + (active ?? 0) : 0,
  })

  const svgRef = useRef<SVGSVGElement>(null)
  const focusables = [
    ...layout.groups.map((g) => ({ id: diagram.groups[g.index].blockId, x: g.box.x + g.box.w / 2, y: g.box.y + g.box.h / 2 })),
    { id: CORE_ID, x: layout.core.x + layout.core.w / 2, y: layout.core.y + layout.core.h / 2 },
    { id: QUEUE_ID, x: layout.queue.label.x + layout.queue.label.w / 2, y: layout.queue.label.y + layout.queue.label.h / 2 },
    ...layout.readers.map((r) => ({ id: model.readers[r.index].id, x: r.box.x + r.box.w / 2, y: r.box.y + r.box.h / 2 })),
  ]

  // One handler for the whole diagram: the block that has focus is the event's target.
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const target = event.target instanceof Element ? event.target : null
    const id = target?.getAttribute('data-syn-id')
    if (!target || !id) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(id)
      return
    }
    const direction = ARROWS[event.key]
    if (!direction) return
    const next = moveFocus(focusables, id, direction)
    if (!next) return
    event.preventDefault()
    const blocks = svgRef.current?.querySelectorAll<SVGGElement>('[data-syn-id]') ?? []
    for (const block of blocks) {
      if (block.getAttribute('data-syn-id') === next) block.focus()
    }
  }

  const blockProps = (id: string, label: string) => ({
    className: cx(styles.block, selectedId === id && styles.selected),
    'data-syn-id': id,
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': `${label}. Select for details`,
    'aria-pressed': selectedId === id,
    onClick: () => onSelect(id),
  })

  const ring = (box: Box, radius = 4) => (
    <rect className={styles.ring} x={box.x - 3} y={box.y - 3} width={box.w + 6} height={box.h + 6} rx={radius + 2} />
  )

  return (
    <div className={styles.root}>
      <div className={styles.wide}>
        <svg
          ref={svgRef}
          className={styles.svg}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          onKeyDown={onKeyDown}
          aria-label="GBrain: source groups feed the core, the core feeds the readers"
        >
          {/* tracks: drawn first, so blocks sit on top. They carry no information of their own. */}
          <g aria-hidden="true">
            {layout.groupTracks.map(({ index, points }) => (
              <g key={diagram.groups[index].id} className={styles.track} data-tone={diagram.groups[index].tone}>
                <path className={styles.ties} d={trackPath(points)} />
                <path className={styles.rail} d={trackPath(points)} />
              </g>
            ))}
            {layout.readerTracks.map(({ index, points }) => (
              <g key={model.readers[index].id} className={styles.track}>
                <path className={styles.ties} d={trackPath(points)} />
                <path className={styles.rail} d={trackPath(points)} />
              </g>
            ))}
            <g className={styles.track}>
              <path className={styles.ties} d={trackPath(layout.queue.siding)} />
              <path className={styles.rail} d={trackPath(layout.queue.siding)} />
              <rect className={styles.bumper} {...layout.queue.bumper} />
            </g>
          </g>

          {/* source groups */}
          {layout.groups.map(({ index, box, firstRowY }) => {
            const group = diagram.groups[index]
            return (
              <g key={group.id} {...blockProps(group.blockId, groupLabel(group))} data-tone={group.tone}>
                {ring(box, 3)}
                <rect className={styles.frame} x={box.x} y={box.y} width={box.w} height={box.h} rx={3} />
                <rect className={styles.head} x={box.x} y={box.y} width={box.w} height={GROUP_HEADER_H} rx={3} />
                <rect className={styles.headFill} x={box.x} y={box.y + GROUP_HEADER_H - 4} width={box.w} height={4} />
                <text className={cx(styles.headText, 'caps')} x={box.x + 10} y={box.y + 17.5}>
                  {group.label} ({group.sources.length})
                </text>
                <text className={cx(styles.headText, styles.headEnd)} x={box.x + box.w - 10} y={box.y + 17.5} textAnchor="end">
                  {pagesTotal(group.totalPages)}
                </text>
                {group.sources.length === 0 && (
                  <text className={styles.muted} x={box.x + 10} y={firstRowY + 13}>
                    No sources read
                  </text>
                )}
                {group.sources.map((source, row) => {
                  const rowY = firstRowY + row * GROUP_ROW_H
                  const name = truncateLabel(source.id, NAME_CHARS)
                  return (
                    <g key={source.id} data-source-id={source.id} data-sync-off={source.syncOff || undefined}>
                      <title>
                        {source.id}: {source.syncOff ? 'sync off' : word(source.state)}, {pagesText(source.pages)} pages
                      </title>
                      <Mark state={source.state} x={box.x + 10} y={rowY + 3} />
                      <text className={cx(styles.rowText, source.syncOff && styles.rowOff)} x={box.x + 28} y={rowY + 13}>
                        {name.text}
                      </text>
                      <text className={cx(styles.rowText, styles.num)} x={box.x + box.w - 10} y={rowY + 13} textAnchor="end">
                        {pagesText(source.pages)}
                      </text>
                    </g>
                  )
                })}
              </g>
            )
          })}

          {/* core readings */}
          <g role="group" aria-label="Core readings">
            {readings.map((reading, i) => (
              <CoreRow key={reading.label} reading={reading} x={layout.readings.x} y={layout.readings.firstRowY + i * layout.readings.rowH} last={i === readings.length - 1} />
            ))}
          </g>

          {/* the core */}
          <g {...blockProps(CORE_ID, `GBrain core, ${fmtCount(num(syn.core.pages?.value))} pages`)}>
            {ring(layout.core, 8)}
            <rect className={styles.coreFrame} x={layout.core.x} y={layout.core.y} width={layout.core.w} height={layout.core.h} rx={8} />
            <text className={cx(styles.coreTitle, 'caps')} x={layout.core.x + layout.core.w / 2} y={layout.core.y + 34} textAnchor="middle">
              GBrain
            </text>
            <text className={cx(styles.coreTitle, 'caps')} x={layout.core.x + layout.core.w / 2} y={layout.core.y + 56} textAnchor="middle">
              core
            </text>
            {model.core.state !== 'healthy' && (
              <g>
                <Mark state={model.core.state} x={layout.core.x + layout.core.w / 2 - 28} y={layout.core.y + 66} />
                <text className={cx(styles.coreSmall, styles.coreState)} data-state={model.core.state} x={layout.core.x + layout.core.w / 2 - 12} y={layout.core.y + 76}>
                  {word(model.core.state)}
                </text>
              </g>
            )}
            <text className={styles.coreText} x={layout.core.x + layout.core.w / 2} y={layout.core.y + 100} textAnchor="middle">
              {fmtCount(num(syn.core.chunks?.value))} chunks
            </text>
            <text className={styles.coreText} x={layout.core.x + layout.core.w / 2} y={layout.core.y + 117} textAnchor="middle">
              {fmtCount(num(syn.core.embedded?.value))} embedded
            </text>
            <text className={styles.coreText} x={layout.core.x + layout.core.w / 2} y={layout.core.y + 133} textAnchor="middle">
              ({fmtPercent(percent)})
            </text>
          </g>

          {/* embedding queue */}
          <g {...blockProps(QUEUE_ID, `Embedding queue, ${queueRead ? `${waiting} waiting` : 'not read'}`)} data-state={model.queue.state}>
            {ring(layout.queue.label, 3)}
            <rect className={styles.queueFrame} x={layout.queue.label.x} y={layout.queue.label.y} width={layout.queue.label.w} height={layout.queue.label.h} rx={3} />
            <text className={cx(styles.queueText, 'caps')} x={layout.queue.label.x + layout.queue.label.w / 2} y={layout.queue.label.y + 17} textAnchor="middle">
              Embedding queue
            </text>
          </g>
          <g aria-label="Embedding jobs" role="group">
            {layout.queue.units.map((unit, i) => {
              const isActive = i < (active ?? 0)
              return (
                <g key={i} className={cx(styles.unit, isActive && styles.unitActive)} data-unit={isActive ? 'active' : 'waiting'}>
                  <title>{isActive ? 'Embedding job running' : 'Embedding job waiting'}</title>
                  <rect x={unit.x} y={unit.y} width={22} height={16} rx={3} />
                  <text x={unit.x + 11} y={unit.y + 12.5} textAnchor="middle">
                    {isActive ? 'A' : 'W'}
                  </text>
                </g>
              )
            })}
            {layout.queue.more > 0 && (
              <text className={styles.muted} x={layout.queue.units[layout.queue.units.length - 1].x + 30} y={layout.queue.units[layout.queue.units.length - 1].y + 11}>
                +{layout.queue.more}
              </text>
            )}
          </g>
          <QueueCaption x={layout.queue.caption.x} y={layout.queue.caption.y} state={model.queue.state} waiting={waiting} active={active} stalled={stalled} />

          {/* readers: set up, or not set up. A configuration reading is never a live state. */}
          {layout.readers.map(({ index, box }) => {
            const reader = model.readers[index]
            return (
              <g
                key={reader.id}
                {...blockProps(reader.id, `${reader.label}, ${readerSub(reader)}. ${READERS_CAPTION}`)}
                data-presence={reader.presence}
                data-state={reader.neutral ? undefined : reader.state}
              >
                {ring(box, 3)}
                <rect className={styles.readerFrame} x={box.x} y={box.y} width={box.w} height={box.h} rx={3} />
                <text className={styles.readerName} x={box.x + 10} y={box.y + 17}>
                  {truncateLabel(reader.label, Math.floor((READER_W - 20) / 7)).text}
                </text>
                {!reader.neutral && <Mark state={reader.state} x={box.x + 10} y={box.y + 24} />}
                <text className={styles.readerSub} x={box.x + (reader.neutral ? 10 : 26)} y={box.y + 33}>
                  {readerSub(reader)}
                </text>
              </g>
            )
          })}
          {model.readers.some((reader) => reader.neutral) && (
            <text className={styles.caption} x={layout.readerCaption.x} y={layout.readerCaption.y}>
              {wrapWords(READERS_CAPTION, 27).map((line, i) => (
                <tspan key={line} x={layout.readerCaption.x} dy={i === 0 ? 0 : 15}>
                  {line}
                </tspan>
              ))}
            </text>
          )}
        </svg>
      </div>

      <div className={styles.narrow}>
        <TrackList syn={syn} model={model} diagram={diagram} readings={readings} selectedId={selectedId} onSelect={onSelect} />
      </div>

      <Legend />
    </div>
  )
}

function CoreRow({ reading, x, y, last }: { reading: CoreReading; x: number; y: number; last: boolean }) {
  const marked = reading.unread || reading.state === 'warning' || reading.state === 'critical'
  return (
    <g data-reading={reading.label}>
      {last && <line className={styles.rule} x1={x} x2={x + 240} y1={y - 12} y2={y - 12} />}
      <text className={styles.readLabel} x={x} y={y + 6}>
        {reading.label}
      </text>
      {marked && <Mark state={reading.unread ? 'unavailable' : reading.state} x={x + 100} y={y - 5} />}
      <text className={cx(styles.readValue, marked && styles.readValueMarked)} data-state={reading.unread ? 'unavailable' : reading.state} x={x + (marked ? 116 : 100)} y={y + 6}>
        {reading.value}
      </text>
    </g>
  )
}

function QueueCaption({
  x,
  y,
  state,
  waiting,
  active,
  stalled,
}: {
  x: number
  y: number
  state: UiState
  waiting: number | null
  active: number | null
  stalled: number | null
}) {
  if (waiting === null) {
    return (
      <g data-queue-caption>
        <Mark state="unavailable" x={x} y={y - 10} />
        <text className={styles.readLabel} x={x + 16} y={y}>
          not read
        </text>
      </g>
    )
  }
  const abnormal = state === 'warning' || state === 'critical'
  return (
    <g data-queue-caption>
      {abnormal && <Mark state={state} x={x} y={y - 10} />}
      <text className={styles.readLabel} x={x + (abnormal ? 16 : 0)} y={y}>
        {fmtCount(waiting)} waiting | {fmtCount(active)} active | {fmtCount(stalled)} stalled
      </text>
    </g>
  )
}

function Legend() {
  return (
    <ul className={styles.legend} aria-label="Legend">
      <li><StateMark state="healthy" /> normal</li>
      <li><StateMark state="warning" /> caution</li>
      <li><StateMark state="critical" /> critical</li>
      <li><StateMark state="unavailable" /> not read</li>
      <li><StateMark state="inactive" /> sync off</li>
      <li>
        <svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true" className={styles.legendUnit}>
          <rect x="0.5" y="0.5" width="21" height="13" rx="3" />
          <text x="11" y="10.5" textAnchor="middle">W</text>
        </svg>{' '}
        job waiting
      </li>
      <li>
        <svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true" className={cx(styles.legendUnit, styles.legendUnitActive)}>
          <rect x="0.5" y="0.5" width="21" height="13" rx="3" />
          <text x="11" y="10.5" textAnchor="middle">A</text>
        </svg>{' '}
        job running
      </li>
    </ul>
  )
}

function ListRow({ children }: { children: ReactNode }) {
  return <li className={styles.listRow}>{children}</li>
}

/**
 * The narrow layout (under about 900px): the same readings as a list. Every group and every source is
 * listed, so nothing the diagram shows is lost. Selecting works through a Details button per block.
 */
function TrackList({
  syn,
  model,
  diagram,
  readings,
  selectedId,
  onSelect,
}: {
  syn: GBrainSynoptic
  model: BrainModel
  diagram: Diagram
  readings: CoreReading[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const waiting = num(syn.queue.waiting?.value)
  const active = num(syn.queue.active?.value)
  const stalled = num(syn.queue.stalled?.value)
  return (
    <div className={styles.list}>
      {diagram.groups.map((group) => (
        <Block
          key={group.id}
          tone={group.tone}
          title={`${group.label} (${group.sources.length})`}
          meta={pagesTotal(group.totalPages)}
          padding="sm"
          titleAs="h3"
        >
          <ul className={styles.rows} data-list-id={group.blockId}>
            {group.sources.length === 0 && <ListRow><span className={styles.muted}>No sources read</span></ListRow>}
            {group.sources.map((source) => (
              <ListRow key={source.id}>
                <StateMark state={source.state} />
                <span className={cx(styles.listName, source.syncOff && styles.rowOff)}>{source.id}</span>
                {source.syncOff && <span className={styles.listWord}>sync off</span>}
                {!source.syncOff && source.state !== 'healthy' && <span className={styles.listWord} data-state={source.state}>{word(source.state)}</span>}
                <span className={styles.listNum}>{pagesText(source.pages)}</span>
              </ListRow>
            ))}
          </ul>
          <Button size="sm" className={styles.details} aria-pressed={selectedId === group.blockId} aria-label={`${group.label} details`} onClick={() => onSelect(group.blockId)}>
            Details
          </Button>
        </Block>
      ))}
      <Block
        title="GBrain core"
        meta={fmtPercent(embeddedPercent(syn.core)) + ' embedded'}
        actions={
          <Button size="sm" aria-pressed={selectedId === CORE_ID} aria-label="GBrain core details" onClick={() => onSelect(CORE_ID)}>
            Details
          </Button>
        }
        padding="sm"
        titleAs="h3"
      >
        <dl className={styles.facts} data-list-id={CORE_ID}>
          {readings.map((reading) => (
            <div key={reading.label} className={styles.fact}>
              <dt>{reading.label}</dt>
              <dd>
                {(reading.unread || reading.state === 'warning' || reading.state === 'critical') && <StateMark state={reading.unread ? 'unavailable' : reading.state} />}
                {reading.value}
              </dd>
            </div>
          ))}
        </dl>
      </Block>
      <Block
        title="Embedding queue"
        actions={
          <Button size="sm" aria-pressed={selectedId === QUEUE_ID} aria-label="Embedding queue details" onClick={() => onSelect(QUEUE_ID)}>
            Details
          </Button>
        }
        padding="sm"
        titleAs="h3"
      >
        <p className={styles.facts} data-list-id={QUEUE_ID}>
          {waiting === null ? (
            <span><StateMark state="unavailable" /> not read</span>
          ) : (
            <span>
              {model.queue.state === 'warning' || model.queue.state === 'critical' ? <StateMark state={model.queue.state} /> : null}
              {fmtCount(waiting)} waiting | {fmtCount(active)} active | {fmtCount(stalled)} stalled
            </span>
          )}
        </p>
      </Block>
      <Block title="Readers" meta={`${model.readers.length}`} padding="sm" titleAs="h3">
        <ul className={styles.rows} data-list-id="readers">
          {model.readers.map((reader) => (
            <ListRow key={reader.id}>
              <Button size="sm" variant="ghost" aria-pressed={selectedId === reader.id} onClick={() => onSelect(reader.id)}>
                {reader.label}
              </Button>
              <span className={styles.listWord} data-presence={reader.presence}>{readerSub(reader)}</span>
            </ListRow>
          ))}
        </ul>
        {model.readers.some((reader) => reader.neutral) && <p className={styles.muted}>{READERS_CAPTION}</p>}
      </Block>
    </div>
  )
}
