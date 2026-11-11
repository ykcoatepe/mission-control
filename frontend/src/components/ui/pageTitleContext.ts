import { createContext, useContext, useEffect } from 'react'

/**
 * The page title is shown once, in the top bar. `Page` publishes it here and
 * the shell reads it. Outside the shell (tests, Setup) the context is a no-op.
 */
export interface PageTitleContextValue {
  title: string | null
  setTitle: (title: string | null) => void
}

export const PageTitleContext = createContext<PageTitleContextValue>({
  title: null,
  setTitle: () => {},
})

/** The title published by the current page, or null when none is mounted. */
export function usePageTitle(): string | null {
  return useContext(PageTitleContext).title
}

/** Publish a page title to the shell and to `document.title` while mounted. */
export function usePublishPageTitle(title: string): void {
  const { setTitle } = useContext(PageTitleContext)
  useEffect(() => {
    setTitle(title)
    const previous = document.title
    document.title = `${title} · Mission Control`
    return () => {
      setTitle(null)
      document.title = previous
    }
  }, [setTitle, title])
}
