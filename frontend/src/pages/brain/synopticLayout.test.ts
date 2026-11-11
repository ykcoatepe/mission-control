import { describe, expect, it } from 'vitest'
import {
  CORE_H,
  MIN_WIDTH,
  computeSynopticLayout,
  moveFocus,
  pathData,
  truncateLabel,
  type Box,
  type Point,
} from './synopticLayout'

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
const layout = (readers: number, groups: number, width = 1100) =>
  computeSynopticLayout({ width, readerIds: ids('r', readers), groupIds: ids('g', groups), queueId: 'queue' })

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

function rectilinear(points: Point[]) {
  return points.every((p, i) => i === 0 || p.x === points[i - 1].x || p.y === points[i - 1].y)
}

describe('computeSynopticLayout', () => {
  it.each([
    [4, 4],
    [1, 1],
    [0, 0],
    [8, 2],
    [2, 9],
  ])('places %i readers and %i source groups without overlapping boxes', (readers, groups) => {
    const l = layout(readers, groups)
    const boxes = [l.core, l.queue, ...l.readers.map((r) => r.box), ...l.groups.map((g) => g.box)]
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false)
    }
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.w).toBeLessThanOrEqual(l.width)
      expect(box.y + box.h).toBeLessThanOrEqual(l.height)
    }
    expect(l.readers).toHaveLength(readers)
    expect(l.groups).toHaveLength(groups)
    expect(l.edges).toHaveLength(readers + groups + 1)
  })

  it('grows taller with more rows and centres the core against the taller side', () => {
    const small = layout(2, 2)
    const big = layout(9, 3)
    expect(big.height).toBeGreaterThan(small.height)
    const stackTop = big.readers[0].box.y
    const stackBottom = big.readers[8].box.y + big.readers[8].box.h
    expect(big.core.y + CORE_H / 2).toBeCloseTo((stackTop + stackBottom) / 2, -1)
  })

  it('keeps readers left, the core centre, sources right and the queue under the core', () => {
    const l = layout(3, 3)
    for (const r of l.readers) expect(r.box.x + r.box.w).toBeLessThan(l.core.x)
    for (const g of l.groups) expect(g.box.x).toBeGreaterThan(l.core.x + l.core.w)
    expect(l.queue.y).toBeGreaterThan(l.core.y + l.core.h)
    expect(l.queue.x).toBe(l.core.x)
  })

  it('draws only right-angle lines that end with an arrow tip on the core', () => {
    const l = layout(5, 6)
    l.edges.forEach((edge) => {
      expect(rectilinear(edge.points)).toBe(true)
      const tip = edge.arrow[0]
      const onLeft = tip.x === l.core.x && tip.y >= l.core.y && tip.y <= l.core.y + l.core.h
      const onRight = tip.x === l.core.x + l.core.w && tip.y >= l.core.y && tip.y <= l.core.y + l.core.h
      const onBottom = tip.y === l.core.y + l.core.h && tip.x >= l.core.x && tip.x <= l.core.x + l.core.w
      expect(onLeft || onRight || onBottom).toBe(true)
      // The line stops where the arrow starts.
      const end = edge.points[edge.points.length - 1]
      expect(Math.abs(end.x - tip.x) + Math.abs(end.y - tip.y)).toBe(6)
    })
  })

  it('never lets two vertical runs on one side share a column and a row range', () => {
    const l = layout(8, 8)
    const side = l.edges.slice(0, 8)
    const verticals = side.flatMap((edge) =>
      edge.points.flatMap((p, i) =>
        i > 0 && p.x === edge.points[i - 1].x && p.y !== edge.points[i - 1].y
          ? [{ x: p.x, lo: Math.min(p.y, edge.points[i - 1].y), hi: Math.max(p.y, edge.points[i - 1].y) }]
          : [],
      ),
    )
    for (let i = 0; i < verticals.length; i++) {
      for (let j = i + 1; j < verticals.length; j++) {
        const a = verticals[i]
        const b = verticals[j]
        if (a.x === b.x) expect(a.hi < b.lo || b.hi < a.lo).toBe(true)
      }
    }
  })

  it('keeps vertical runs clear of the label zone next to each block', () => {
    const l = layout(6, 6)
    for (const edge of l.edges.slice(0, 6)) {
      const startX = edge.points[0].x
      for (const p of edge.points.slice(1)) {
        if (p.x !== startX) expect(p.x - startX).toBeGreaterThanOrEqual(edge.label.maxWidth)
      }
    }
  })

  it('clamps widths below the minimum and still lays out', () => {
    const l = layout(4, 4, 300)
    expect(l.width).toBe(MIN_WIDTH)
    expect(l.core.x).toBeGreaterThan(l.readers[0].box.x + l.readers[0].box.w)
  })

  it('serialises a path for SVG', () => {
    expect(pathData([{ x: 1, y: 2 }, { x: 3, y: 2 }])).toBe('M1 2 L3 2')
  })
})

describe('truncateLabel', () => {
  it('keeps short labels as they are', () => {
    expect(truncateLabel('Projects', 12)).toEqual({ text: 'Projects', full: 'Projects', truncated: false })
  })

  it('truncates long labels and keeps the full text for the title', () => {
    const result = truncateLabel('gstack-code-github-com-garrytan', 12)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(12)
    expect(result.text.endsWith('…')).toBe(true)
    expect(result.full).toBe('gstack-code-github-com-garrytan')
  })

  it('handles degenerate limits', () => {
    expect(truncateLabel('abc', 0).text).toBe('…')
    expect(truncateLabel('', 5).text).toBe('')
  })
})

describe('moveFocus', () => {
  const items = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 0, y: 100 },
    { id: 'c', x: 200, y: 10 },
    { id: 'd', x: 400, y: 0 },
  ]

  it('moves to the nearest item in the pressed direction', () => {
    expect(moveFocus(items, 'a', 'down')).toBe('b')
    expect(moveFocus(items, 'a', 'right')).toBe('c')
    expect(moveFocus(items, 'c', 'right')).toBe('d')
    expect(moveFocus(items, 'd', 'left')).toBe('c')
  })

  it('stays put at an edge and recovers from an unknown current item', () => {
    expect(moveFocus(items, 'a', 'up')).toBeNull()
    expect(moveFocus(items, 'missing', 'left')).toBe('a')
    expect(moveFocus([], 'x', 'left')).toBeNull()
  })
})

describe('the caption under the Readers heading', () => {
  const CAPTION = "Set up to use GBrain. Live connections can't be read from this machine.".length
  const withCaption = (readers: number, width = 1100) =>
    computeSynopticLayout({ width, readerIds: ids('r', readers), groupIds: ids('g', 4), queueId: 'queue', readerCaptionChars: CAPTION })

  it.each([[4, 1100], [2, 960], [1, 720], [4, 720]])('leaves it clear of the heading and of the first reader (%i readers at %i px)', (readers, width) => {
    const l = withCaption(readers, width)
    const header = l.headers.find((h) => h.id === 'readers')!
    const caption = l.readerCaption!
    expect(caption.y).toBeGreaterThan(header.y)
    expect(caption.w).toBe(l.readers[0].box.w)
    expect(l.readers[0].box.y).toBeGreaterThanOrEqual(caption.y + caption.h)
    // Everything still fits inside the drawing, and the other columns do not move.
    expect(l.height).toBeGreaterThanOrEqual(l.readers[readers - 1].box.y + l.readers[readers - 1].box.h)
    const boxes = [l.core, l.queue, ...l.readers.map((r) => r.box), ...l.groups.map((g) => g.box)]
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)))
  })

  it('is absent without a request, and then the layout is the one it always was', () => {
    expect(layout(4, 4).readerCaption).toBeNull()
    expect(layout(4, 4).readers[0].box.y).toBe(layout(4, 4).groups[0].box.y)
  })
})
