import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { appRoutes } from './appRoutes'
import styles from './App.module.css'
import CommandPalette from './components/CommandPalette'
import RouteErrorBoundary from './components/RouteErrorBoundary'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import { PageTitleProvider, Skeleton, ToastProvider } from './components/ui'
import { useApi } from './lib/hooks'
import { useAfterWriteRefresh } from './lib/writes'
import { cx } from './components/ui/cx'
import { useMediaQuery } from './components/ui/useMediaQuery'

const COLLAPSED_KEY = 'mc-sidebar-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function RouteFallback() {
  return (
    <div className={styles.fallback}>
      <Skeleton lines={2} label="Loading page" />
      <Skeleton variant="block" />
      <Skeleton variant="block" size="lg" />
    </div>
  )
}

export default function App() {
  useAfterWriteRefresh()
  const location = useLocation()
  const navigate = useNavigate()
  const mainRef = useRef<HTMLElement>(null)
  // The drawer is open only for the page it was opened on, so navigating closes it.
  const [navOpenedAt, setNavOpenedAt] = useState<string | null>(null)
  const navOpen = navOpenedAt === location.pathname
  // While the off-canvas navigation is open it is a modal: the page behind it is inert.
  const drawerMode = useMediaQuery('(max-width: 899px)')
  const navModal = navOpen && drawerMode
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const { data: setupData } = useApi<{ needsSetup?: boolean }>('/api/setup')

  useEffect(() => {
    if (location.pathname !== '/setup' && setupData?.needsSetup) navigate('/setup')
  }, [location.pathname, navigate, setupData?.needsSetup])

  // A new page starts at the top.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [location.pathname])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        // Storage can be blocked; the choice still applies for this session.
      }
      return next
    })
  }, [])

  const closeNav = useCallback(() => setNavOpenedAt(null), [])
  const isSetupPage = location.pathname === '/setup'

  const routed = (
    <RouteErrorBoundary resetKey={location.pathname}>
      <Suspense fallback={<RouteFallback />}>
        <Routes location={location}>
          {appRoutes.map((route) => {
            const Component = route.component
            return <Route key={route.path} path={route.path} element={<Component />} />
          })}
        </Routes>
      </Suspense>
    </RouteErrorBoundary>
  )

  if (isSetupPage) {
    return (
      <ToastProvider>
        <PageTitleProvider>
          <main className={styles.setup}>{routed}</main>
        </PageTitleProvider>
      </ToastProvider>
    )
  }

  return (
    <ToastProvider>
      <PageTitleProvider>
        <a href="#main-content" className={styles.skipLink} inert={navModal}>
          Skip to content
        </a>
        <div className={cx(styles.shell, collapsed && styles.shellCollapsed)}>
          <Sidebar collapsed={collapsed} onToggleCollapsed={toggleCollapsed} open={navOpen} onClose={closeNav} />
          {navOpen && <div className={styles.scrim} onClick={closeNav} aria-hidden="true" />}
          <div className={styles.workspace} inert={navModal}>
            <TopBar
              onOpenMenu={() => setNavOpenedAt(location.pathname)}
              onOpenPalette={() => setPaletteOpen(true)}
              menuExpanded={navModal}
            />
            <main id="main-content" ref={mainRef} tabIndex={-1} className={styles.main}>
              <div className={styles.content}>{routed}</div>
            </main>
          </div>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </PageTitleProvider>
    </ToastProvider>
  )
}
