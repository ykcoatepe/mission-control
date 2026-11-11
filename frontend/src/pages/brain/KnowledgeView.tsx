import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Drawer,
  EmptyState,
  ErrorState,
  Mono,
  Notice,
  Panel,
  SearchInput,
  Skeleton,
} from '../../components/ui'
import { apiQueryOptions } from '../../lib/hooks'
import styles from './KnowledgeView.module.css'
import { MIN_QUERY_LENGTH, describeLookupFailure, pageUrl, searchUrl } from './lib'
import type { Envelope, PageData, SearchData, SearchResult } from './types'

const DEBOUNCE_MS = 300
function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

const oneLine = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()

export function KnowledgeView() {
  const [params, setParams] = useSearchParams()
  const urlQuery = params.get('q') ?? ''
  const [value, setValue] = useState(urlQuery)
  const debounced = useDebounced(value, DEBOUNCE_MS)
  const [slug, setSlug] = useState<string | null>(null)

  // Keep the address bar in step with what was searched (replace: no history spam).
  useEffect(() => {
    if (debounced === urlQuery) return
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (debounced) next.set('q', debounced)
        else next.delete('q')
        return next
      },
      { replace: true },
    )
  }, [debounced, urlQuery, setParams])

  const url = searchUrl(debounced)
  const search = useQuery({
    ...apiQueryOptions<Envelope<SearchData>>(url ?? '/api/gbrain/search'),
    enabled: url !== null,
  })
  const settling = value.trim() !== debounced.trim()

  return (
    <Panel
      title="Search the brain"
      description="Pages from every source. Select a result to read it."
      actions={
        <SearchInput
          className={styles.search}
          value={value}
          onChange={setValue}
          label="Search pages"
          placeholder="Search pages…"
        />
      }
    >
      <SearchResults
        enabled={url !== null}
        settling={settling}
        loading={search.isFetching && !search.data}
        failure={search.error ?? null}
        envelope={search.data ?? null}
        onRetry={() => void search.refetch()}
        onSelect={setSlug}
      />
      <PageDrawer slug={slug} onClose={() => setSlug(null)} />
    </Panel>
  )
}

function SearchResults({
  enabled,
  settling,
  loading,
  failure,
  envelope,
  onRetry,
  onSelect,
}: {
  enabled: boolean
  settling: boolean
  loading: boolean
  failure: Error | null
  envelope: Envelope<SearchData> | null
  onRetry: () => void
  onSelect: (slug: string) => void
}) {
  if (!enabled) {
    return (
      <EmptyState
        title="Search the brain"
        description={`Type at least ${MIN_QUERY_LENGTH} characters to search pages.`}
      />
    )
  }
  if (loading) return <Skeleton lines={4} label="Searching" />
  const data = envelope?.data
  if (!envelope || !data) {
    const problem = describeLookupFailure(failure, 'Search')
    return <ErrorState title={problem.title} message={problem.message} onRetry={onRetry} retryLabel={problem.kind === 'busy' ? 'Try again' : 'Retry'} />
  }
  const results: SearchResult[] = data.results
  return (
    <div className={styles.results} aria-busy={settling || undefined}>
      {(envelope.meta.stale || failure) && (
        <Notice tone="warning">These results are from an earlier reading and may be out of date.</Notice>
      )}
      {(data.withheld ?? 0) > 0 && (
        <Notice tone="info">
          {data.withheld} {data.withheld === 1 ? 'result is' : 'results are'} withheld because they come from private
          session records.
        </Notice>
      )}
      {results.length === 0 ? (
        <EmptyState title="No pages match" description="Try a different word, or fewer words." />
      ) : (
        <ul className={styles.list}>
          {results.map((result) => (
            <li key={result.slug}>
              <button type="button" className={styles.result} onClick={() => onSelect(result.slug)}>
                <span className={styles.title}>{result.title || result.slug}</span>
                <Mono muted truncate className={styles.slug}>
                  {result.slug}
                </Mono>
                {result.snippet && <span className={styles.snippet}>{oneLine(result.snippet)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PageDrawer({ slug, onClose }: { slug: string | null; onClose: () => void }) {
  const query = useQuery({
    ...apiQueryOptions<Envelope<PageData>>(slug ? pageUrl(slug) : '/api/gbrain/pages/none'),
    enabled: slug !== null,
  })
  const page = query.data?.data ?? null
  return (
    <Drawer
      open={slug !== null}
      onClose={onClose}
      size="lg"
      title={page?.title || slug || ''}
      description={slug ? <Mono muted>{slug}</Mono> : undefined}
    >
      {query.isLoading ? (
        <Skeleton lines={8} label="Loading page" />
      ) : query.error || !page ? (
        <PageProblem error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className={styles.page}>
          {query.data?.meta.stale && (
            <Notice tone="warning">This is an earlier reading of the page and may be out of date.</Notice>
          )}
          {page.truncated && <Notice tone="info">This page is long. Only the first part is shown.</Notice>}
          {/* Plain text only: page content is never parsed as HTML. */}
          <pre className={styles.text}>{page.content ?? ''}</pre>
        </div>
      )}
    </Drawer>
  )
}

function PageProblem({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const problem = describeLookupFailure(error, 'This page')
  return (
    <ErrorState
      title={problem.title}
      message={problem.message}
      onRetry={onRetry}
      retryLabel={problem.kind === 'busy' ? 'Try again' : 'Retry'}
    />
  )
}
