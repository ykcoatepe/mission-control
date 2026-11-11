import { useState } from 'react'

const KEY = 'gbrain.acknowledgedIncidents'
const KEEP = 50

function read(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Acknowledged recovered regressions. Storage is a convenience: without it the choice lasts for the session. */
export function useAcknowledgedIncidents() {
  const [acknowledged, setAcknowledged] = useState<Set<string>>(read)
  const acknowledge = (keys: readonly string[]) => {
    if (keys.length === 0) return
    const next = new Set(acknowledged)
    for (const key of keys) next.add(key)
    setAcknowledged(next)
    try {
      window.localStorage.setItem(KEY, JSON.stringify([...next].slice(-KEEP)))
    } catch {
      // Keep the in-session acknowledgement.
    }
  }
  return { acknowledged, acknowledge }
}
