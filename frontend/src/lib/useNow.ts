import { useSyncExternalStore } from 'react'

/**
 * A shared ticking clock for relative-time displays. Components read `useNow()`
 * instead of calling `Date.now()` during render, so renders stay pure.
 */
const listeners = new Set<() => void>()
let current = 0
let timer: ReturnType<typeof setInterval> | null = null

const TICK_MS = 15_000

function tick() {
  current = Date.now()
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    current = Date.now()
    timer = setInterval(tick, TICK_MS)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function getSnapshot() {
  // Before the first subscription there is no ticker; seed once, outside React's render phase rules.
  if (current === 0) current = Date.now()
  return current
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
