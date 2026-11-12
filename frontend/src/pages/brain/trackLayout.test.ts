import { describe, expect, it } from 'vitest'
import {
  CORE_X,
  GROUP_W,
  MAX_QUEUE_UNITS,
  READER_X,
  computeTrackLayout,
  groupHeight,
  moveFocus,
  trackPath,
  truncateLabel,
  wrapWords,
  type Point,
} from './trackLayout'

const layout = (over: Partial<Parameters<typeof computeTrackLayout>[0]> = {}) =>
  computeTrackLayout({ groupRows: [3, 9, 3, 1], readerCount: 4, queueUnits: 4, ...over })

describe('track layout', () => {
  it('stacks the four group blocks without overlap and sizes each by its rows', () => {
    const { groups } = layout()
    expect(groups.map((g) => g.box.h)).toEqual([3, 9, 3, 1].map(groupHeight))
    for (let i = 1; i < groups.length; i += 1) expect(groups[i].box.y).toBeGreaterThan(groups[i - 1].box.y + groups[i - 1].box.h)
  })

  it('draws one track per group into the core and one per reader out of it, each along right angles', () => {
    const l = layout()
    expect(l.groupTracks).toHaveLength(4)
    expect(l.readerTracks).toHaveLength(4)
    for (const { points } of l.groupTracks) {
      expect(points[0].x).toBe(GROUP_W)
      expect(points[points.length - 1].x).toBe(CORE_X)
    }
    for (const { points } of l.readerTracks) {
      expect(points[0].x).toBe(l.core.x + l.core.w)
      expect(points[points.length - 1].x).toBe(READER_X)
    }
    for (const { points } of [...l.groupTracks, ...l.readerTracks]) {
      for (let i = 1; i < points.length; i += 1) expect(points[i].x === points[i - 1].x || points[i].y === points[i - 1].y).toBe(true)
    }
  })

  it('keeps tracks from crossing: no vertical run sits on another track horizontal run', () => {
    const l = layout()
    const segments = (points: Point[]) => points.slice(1).map((p, i) => [points[i], p] as const)
    const all = l.groupTracks.map((t) => segments(t.points))
    for (let a = 0; a < all.length; a += 1) {
      for (let b = 0; b < all.length; b += 1) {
        if (a === b) continue
        for (const [p, q] of all[a]) {
          if (p.x !== q.x) continue
          for (const [r, s] of all[b]) {
            if (r.y !== s.y) continue
            const crosses = p.x > Math.min(r.x, s.x) && p.x < Math.max(r.x, s.x) && r.y > Math.min(p.y, q.y) && r.y < Math.max(p.y, q.y)
            expect(crosses).toBe(false)
          }
        }
      }
    }
  })

  it('draws at most a handful of queue units and counts the rest', () => {
    expect(layout({ queueUnits: 0 }).queue.units).toHaveLength(0)
    expect(layout({ queueUnits: 4 }).queue.units).toHaveLength(4)
    const many = layout({ queueUnits: 40 })
    expect(many.queue.units).toHaveLength(MAX_QUEUE_UNITS)
    expect(many.queue.more).toBe(40 - MAX_QUEUE_UNITS)
  })

  it('keeps the siding clear of the readers column and its units on the siding', () => {
    const l = layout({ queueUnits: 40 })
    const end = l.queue.siding[l.queue.siding.length - 1].x
    expect(end).toBeLessThan(READER_X)
    for (const unit of l.queue.units) expect(unit.x + 22).toBeLessThan(end)
    expect(l.readerCaption.x).toBeGreaterThanOrEqual(READER_X)
  })

  it('copes with no readers and with a group that has no sources', () => {
    const l = layout({ readerCount: 0, groupRows: [0, 2] })
    expect(l.readers).toHaveLength(0)
    expect(l.readerTracks).toHaveLength(0)
    expect(l.groups[0].box.h).toBe(groupHeight(1))
  })
})

describe('trackPath', () => {
  it('rounds the corners and ends on the last point', () => {
    const d = trackPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 40 }])
    expect(d.startsWith('M0 0')).toBe(true)
    expect(d).toContain('Q50 0')
    expect(d.endsWith('L100 40')).toBe(true)
  })
})

describe('text helpers', () => {
  it('truncates with an ellipsis and keeps the full text', () => {
    expect(truncateLabel('tk-a320-line-ops', 20)).toEqual({ text: 'tk-a320-line-ops', full: 'tk-a320-line-ops', truncated: false })
    const cut = truncateLabel('a-very-long-source-identifier', 10)
    expect(cut.text.length).toBe(10)
    expect(cut.text.endsWith('…')).toBe(true)
    expect(cut.full).toBe('a-very-long-source-identifier')
  })

  it('wraps words by character count without breaking one', () => {
    expect(wrapWords("Live connections can't be read from this machine.", 27)).toEqual(["Live connections can't be", 'read from this machine.'])
  })
})

describe('arrow keys move to the nearest block in that direction', () => {
  const items = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 0, y: 100 },
    { id: 'c', x: 200, y: 10 },
  ]
  it('goes down, right and not past the edge', () => {
    expect(moveFocus(items, 'a', 'down')).toBe('b')
    expect(moveFocus(items, 'a', 'right')).toBe('c')
    expect(moveFocus(items, 'a', 'up')).toBeNull()
    expect(moveFocus(items, 'a', 'left')).toBeNull()
    expect(moveFocus(items, 'missing', 'left')).toBe('a')
  })
})
