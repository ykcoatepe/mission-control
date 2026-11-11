import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'mc-theme'
const listeners = new Set<() => void>()
let current: Theme = 'dark'

function readStored(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function apply(theme: Theme) {
  current = theme
  document.documentElement.setAttribute('data-theme', theme)
}

/** Apply the saved theme (default dark). Call once before the first render. */
export function initTheme() {
  apply(readStored())
}

export function setTheme(theme: Theme) {
  apply(theme)
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Storage can be blocked; the theme still applies for this session.
  }
  listeners.forEach((listener) => listener())
}

export function toggleTheme() {
  setTheme(current === 'dark' ? 'light' : 'dark')
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Theme {
  return current
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { theme, setTheme, toggleTheme }
}
