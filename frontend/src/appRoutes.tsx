/* eslint-disable react-refresh/only-export-components */
import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Navigate } from 'react-router-dom'
import {
  BrainCircuit,
  Hammer,
  DollarSign,
  Clock,
  MessageCircle,
  Settings,
  CalendarDays,
  Brain,
  Building2,
  Landmark,
  Users2,
  Kanban,
  Network,
  Search,
  Wrench,
} from 'lucide-react'

const BrainHome = lazy(() => import('./pages/BrainHome'))
const Chat = lazy(() => import('./pages/Chat'))
const Workshop = lazy(() => import('./pages/Workshop'))
const HermesKanban = lazy(() => import('./pages/HermesKanban'))
const Costs = lazy(() => import('./pages/Costs'))
const Cron = lazy(() => import('./pages/Cron'))
const Agents = lazy(() => import('./pages/Agents'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const Setup = lazy(() => import('./pages/Setup'))
const Calendar = lazy(() => import('./pages/Calendar'))
const OllamaMonitor = lazy(() => import('./pages/OllamaMonitor'))
const Councils = lazy(() => import('./pages/Councils'))
const TeamStructure = lazy(() => import('./pages/TeamStructure'))
const DigitalOffice = lazy(() => import('./pages/DigitalOffice'))
const GBrain = lazy(() => import('./pages/GBrain'))
const Diagnostics = lazy(() => import('./pages/Diagnostics'))

// Redirect shims — thin wrappers so old bookmarks keep working
const RedirectMemory = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/diagnostics?tab=memory" /> })
)
const RedirectScout = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/diagnostics?tab=scout" /> })
)
const RedirectAWS = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/diagnostics?tab=aws" /> })
)
const RedirectSkills = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/diagnostics?tab=skills" /> })
)
const RedirectKanban = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/work" /> })
)
const RedirectCron = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/automations" /> })
)
const RedirectConversations = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/sessions" /> })
)
const RedirectCosts = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/usage" /> })
)
const RedirectAgents = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/systems" /> })
)

type RouteComponent = LazyExoticComponent<ComponentType>

export interface AppRouteDefinition {
  path: string
  label: string
  module: string
  anyModule?: string[]
  component: RouteComponent
  icon?: LucideIcon
  nav?: boolean
  navPlacement?: 'primary' | 'utility'
  section?: 'core' | 'intelligence' | 'system' | 'operate' | 'audit'
  description?: string
}

export const appRoutes: AppRouteDefinition[] = [
  { path: '/setup', label: 'Setup', module: 'settings', component: Setup, nav: false },
  { path: '/', label: 'Brain', module: 'dashboard', component: BrainHome, icon: BrainCircuit, navPlacement: 'primary', section: 'core', description: 'Shared evidence' },
  { path: '/work', label: 'Work', module: 'workshop', component: HermesKanban, icon: Kanban, navPlacement: 'primary', section: 'core', description: 'Hermes work · Phase 1' },
  { path: '/automations', label: 'Automations', module: 'cron', component: Cron, icon: Clock, navPlacement: 'primary', section: 'core', description: 'Cron list · Phase 1' },
  { path: '/sessions', label: 'Sessions', module: 'chat', component: Chat, icon: MessageCircle, navPlacement: 'primary', section: 'core', description: 'OpenClaw sessions' },
  { path: '/gbrain', label: 'Explore', module: 'gbrain', component: GBrain, icon: Search, navPlacement: 'primary', section: 'intelligence', description: 'Memory and sources' },
  { path: '/usage', label: 'Usage', module: 'costs', component: Costs, icon: DollarSign, navPlacement: 'primary', section: 'intelligence', description: 'Spend and model mix' },
  { path: '/systems', label: 'Systems', module: 'agents', component: Agents, icon: Network, navPlacement: 'primary', section: 'system', description: 'Agents · Phase 1' },
  { path: '/settings', label: 'Settings', module: 'settings', component: SettingsPage, icon: Settings, navPlacement: 'utility' },
  { path: '/councils', label: 'Audit', module: 'councils', component: Councils, icon: Landmark, navPlacement: 'utility' },
  // Phase 2 source pages remain directly reachable without crowding primary navigation.
  { path: '/workshop', label: 'Workshop', module: 'workshop', component: Workshop, icon: Hammer, nav: false, section: 'operate', description: 'Tasks' },
  { path: '/calendar', label: 'Calendar', module: 'calendar', component: Calendar, icon: CalendarDays, nav: false, section: 'intelligence', description: 'Schedule' },
  { path: '/office', label: 'Digital Office', module: 'office', component: DigitalOffice, icon: Building2, nav: false, section: 'operate', description: 'Live desks' },
  { path: '/team', label: 'Team Structure', module: 'team', component: TeamStructure, icon: Users2, nav: false, section: 'system', description: 'Agent map' },
  { path: '/ollama', label: 'Ollama Monitor', module: 'ollamaMonitor', component: OllamaMonitor, icon: Brain, nav: false, section: 'system', description: 'Local models' },
  { path: '/diagnostics', label: 'Diagnostics', module: 'settings', anyModule: ['docs', 'scout', 'aws', 'skills'], component: Diagnostics, icon: Wrench, nav: false, section: 'system', description: 'Memory, docs, scout, AWS' },
  // Phase 1 compatibility redirects keep existing bookmarks one-to-one.
  { path: '/kanban', label: 'Hermes Kanban', module: 'workshop', component: RedirectKanban, nav: false },
  { path: '/cron', label: 'Cron Jobs', module: 'cron', component: RedirectCron, nav: false },
  { path: '/conversations', label: 'Conversations', module: 'chat', component: RedirectConversations, nav: false },
  { path: '/costs', label: 'Cost Tracker', module: 'costs', component: RedirectCosts, nav: false },
  { path: '/agents', label: 'Agent Hub', module: 'agents', component: RedirectAgents, nav: false },
  // Legacy redirects — nav:false keeps them out of the sidebar
  { path: '/memory', label: 'Memory', module: 'docs', component: RedirectMemory, nav: false },
  { path: '/scout', label: 'Scout', module: 'scout', component: RedirectScout, nav: false },
  { path: '/aws', label: 'AWS', module: 'aws', component: RedirectAWS, nav: false },
  { path: '/skills', label: 'Skills', module: 'skills', component: RedirectSkills, nav: false },
]

export const primarySidebarRoutes = appRoutes.filter(
  (route) => route.navPlacement === 'primary' && route.icon,
)
export const utilitySidebarRoutes = appRoutes.filter(
  (route) => route.navPlacement === 'utility' && route.icon,
)
export const sidebarRoutes = [...primarySidebarRoutes, ...utilitySidebarRoutes]

export function isRouteEnabled(route: AppRouteDefinition, modules: Record<string, boolean>) {
  if (route.anyModule) return route.anyModule.some((moduleName) => modules[moduleName] !== false)
  if (modules[route.module] !== false) return true
  return false
}
