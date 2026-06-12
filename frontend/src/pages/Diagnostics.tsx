import { lazy, Suspense } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Wrench } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import LoadingSpinner from '../components/LoadingSpinner'
import PageHeader from '../components/ui/PageHeader'
import { useApi } from '../lib/hooks'
import styles from './Diagnostics.module.css'

const MemoryPage = lazy(() => import('./Memory'))
const DocsPage = lazy(() => import('./Docs'))
const ScoutPage = lazy(() => import('./Scout'))
const AWSPage = lazy(() => import('./AWS'))
const SkillsPage = lazy(() => import('./Skills'))

interface TabDef {
  key: string
  label: string
  module: string
  component: React.LazyExoticComponent<React.ComponentType>
}

const TABS: TabDef[] = [
  { key: 'memory', label: 'Memory', module: 'docs', component: MemoryPage },
  { key: 'docs', label: 'Docs', module: 'docs', component: DocsPage },
  { key: 'scout', label: 'Scout', module: 'scout', component: ScoutPage },
  { key: 'aws', label: 'AWS', module: 'aws', component: AWSPage },
  { key: 'skills', label: 'Skills', module: 'skills', component: SkillsPage },
]

export default function Diagnostics() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: config } = useApi<{ modules?: Record<string, boolean> }>('/api/config', 0)

  // A tab is visible when its module flag is not explicitly false
  const visibleTabs = TABS.filter((t) => {
    if (!config?.modules) return true
    return config.modules[t.module] !== false
  })

  // Resolve active tab: prefer ?tab= param if it points to a visible tab; else first visible
  const requested = searchParams.get('tab') ?? ''
  const activeKey =
    visibleTabs.find((t) => t.key === requested)?.key ?? visibleTabs[0]?.key ?? ''

  const activeTab = visibleTabs.find((t) => t.key === activeKey)

  function handleTabClick(key: string) {
    setSearchParams({ tab: key }, { replace: true })
  }

  return (
    <PageTransition>
      <div className={styles.page}>
        <PageHeader
          icon={<Wrench size={22} />}
          title="Diagnostics"
          subtitle="Supporting surfaces: memory, docs, scout, AWS, and skills"
        />

        {visibleTabs.length > 0 && (
          <div className={styles.tabBar}>
            {visibleTabs.map((tab) => (
              <button
                key={tab.key}
                className={`${styles.tabBtn} ${tab.key === activeKey ? styles.tabBtnActive : ''}`}
                onClick={() => handleTabClick(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        <div className={styles.tabContent}>
          {activeTab && (
            <Suspense fallback={<LoadingSpinner />}>
              <activeTab.component />
            </Suspense>
          )}
        </div>
      </div>
    </PageTransition>
  )
}
