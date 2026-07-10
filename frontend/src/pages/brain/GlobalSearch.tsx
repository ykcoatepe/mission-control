import { Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import styles from './BrainHome.module.css'
import { findSearchResults } from './lib'
import type { OperationsOverview } from './types'

export function GlobalSearch({ overview }: { overview: OperationsOverview }) {
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  const results = findSearchResults(query, overview)

  const goTo = (href: string) => {
    setQuery('')
    navigate(href)
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fallbackQuery = query.trim()
    if (results[0]) {
      goTo(results[0].href)
    } else if (fallbackQuery) {
      goTo(`/gbrain?q=${encodeURIComponent(fallbackQuery)}`)
    }
  }

  return (
    <form className={styles.search} role="search" onSubmit={submit}>
      <div className={styles.searchControl}>
        <Search size={15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('')
          }}
          placeholder="Search memory, evidence, work, or systems"
          aria-label="Search Mission Control"
          aria-expanded={Boolean(query)}
          aria-controls="brain-search-results"
          autoComplete="off"
        />
      </div>
      {query ? (
        <ul id="brain-search-results" className={styles.searchResults}>
          {results.length > 0 ? (
            results.map((result) => (
              <li key={`${result.system}:${result.id}`}>
                <button type="button" onClick={() => goTo(result.href)}>
                  <span>{result.system}</span>
                  <strong>{result.label}</strong>
                  <small>{result.detail}</small>
                </button>
              </li>
            ))
          ) : (
            <li className={styles.searchFallback}>
              Press Enter to explore “{query.trim()}” in GBrain
            </li>
          )}
        </ul>
      ) : null}
    </form>
  )
}
