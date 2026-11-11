import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * An architectural rule, not behaviour: every write goes through the helpers in
 * `lib/hooks.ts`, which add the `X-MC-Request: 1` header the server's write
 * guard will enforce. A source scan is the right tool because the failure is
 * "someone wrote a new fetch call and forgot the header".
 */

const SRC = join(__dirname, '..')
const HELPER = join('lib', 'hooks.ts')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

/** The text of the call starting at the "(" at `open`, up to its matching ")". */
function callText(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

const RAW_FETCH = /(?<![\w$])fetch\s*\(/g
const WRITE_METHOD = /method\s*:\s*['"`](?!GET['"`]|HEAD['"`])/i

describe('write guard', () => {
  const files = sources(SRC).filter((file) => relative(SRC, file) !== HELPER)

  it('scans the app source', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('no raw fetch() at all outside lib/hooks.ts: reads use fetchJson, writes use sendJson/postJson/postForm', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(RAW_FETCH)) {
        const call = callText(source, match.index + match[0].length - 1)
        offenders.push(`${relative(SRC, file)}: ${call.slice(0, 80).replace(/\s+/g, ' ')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('no other transport for writes', () => {
    const offenders = files.filter((file) => /XMLHttpRequest|sendBeacon|from ['"]axios['"]/.test(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => relative(SRC, file))).toEqual([])
  })

  it('the scan catches a write that bypasses the helper', () => {
    const bad = "const r = await fetch('/api/x', { method: 'POST', body: '{}' })"
    const open = bad.indexOf('fetch') + 'fetch'.length
    expect(WRITE_METHOD.test(callText(bad, open))).toBe(true)
  })

  it('the helper itself adds the header for every non-safe method', () => {
    const helper = readFileSync(join(SRC, HELPER), 'utf8')
    expect(helper).toMatch(/SAFE_METHODS\.has\(method\)/)
    expect(helper).toMatch(/headers\.set\(WRITE_GUARD_HEADER, '1'\)/)
  })
})
