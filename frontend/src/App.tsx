import { Suspense, useEffect, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Menu, X } from 'lucide-react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useIsMobile } from './lib/useIsMobile'
import { appRoutes } from './appRoutes'
import styles from './App.module.css'
import LoadingSpinner from './components/LoadingSpinner'
import Sidebar from './components/Sidebar'
import { useApi } from './lib/hooks'
import ChatWidget from './components/ChatWidget'

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { data: setupData } = useApi<{ needsSetup?: boolean }>('/api/setup')

  useEffect(() => {
    if (location.pathname !== '/setup' && setupData?.needsSetup) navigate('/setup')
  }, [location.pathname, navigate, setupData?.needsSetup])

  const isSetupPage = location.pathname === '/setup'

  const closeSidebar = () => setSidebarOpen(false)

  return (
    <div className={`macos-desktop ${styles.root}`}>
      {isMobile && !isSetupPage && (
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className={`${styles.mobileMenuButton} ${
            sidebarOpen ? styles.mobileMenuButtonOpen : styles.mobileMenuButtonClosed
          }`}
        >
          {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      )}

      {isMobile && !isSetupPage && (
        <div className={`sidebar-overlay ${sidebarOpen ? 'open' : ''}`} onClick={closeSidebar} />
      )}

      {!isSetupPage && <Sidebar isOpen={sidebarOpen} onClose={closeSidebar} />}

      <main className={styles.main}>
        <div
          className={`${styles.content} ${
            isSetupPage ? styles.contentSetup : isMobile ? styles.contentMobile : ''
          }`}
        >
          <AnimatePresence mode="wait">
            <Suspense fallback={<LoadingSpinner />}>
              <Routes location={location} key={location.pathname}>
                {appRoutes.map((route) => {
                  const Component = route.component
                  return <Route key={route.path} path={route.path} element={<Component />} />
                })}
              </Routes>
            </Suspense>
          </AnimatePresence>
        </div>
      </main>
      {!isSetupPage && <ChatWidget hideLauncher />}
    </div>
  )
}
