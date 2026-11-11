import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { PageTitleContext } from './pageTitleContext'

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null)
  const value = useMemo(() => ({ title, setTitle }), [title])
  return <PageTitleContext.Provider value={value}>{children}</PageTitleContext.Provider>
}
