import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * One query parameter as state: reading it, and writing it with `replace` so a
 * filter change does not add history entries. `null` or an empty string removes
 * the parameter, so the default state keeps a clean URL.
 */
export function useQueryParam(name: string): [string | null, (value: string | null) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get(name)
  const set = useCallback(
    (next: string | null) => {
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev)
          if (next === null || next === '') copy.delete(name)
          else copy.set(name, next)
          return copy
        },
        { replace: true },
      )
    },
    [name, setParams],
  )
  return [value, set]
}

/** `value` when it is one of `allowed`, otherwise `fallback`: a hand-edited URL never produces an unknown filter. */
export function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback
}
