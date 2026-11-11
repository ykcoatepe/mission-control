/* eslint-disable react-refresh/only-export-components */
import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Navigate } from 'react-router-dom'
import {
  BrainCircuit,
  Bell,
  DollarSign,
  Clock,
  Settings,
  CalendarDays,
  Brain,
  Landmark,
  Search,
  Server,
} from 'lucide-react'

const BrainHome = lazy(() => import('./pages/BrainHome'))
const Attention = lazy(() => import('./pages/Attention'))
const Services = lazy(() => import('./pages/Services'))
const Costs = lazy(() => import('./pages/Costs'))
const Cron = lazy(() => import('./pages/Cron'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const Setup = lazy(() => import('./pages/Setup'))
const Calendar = lazy(() => import('./pages/Calendar'))
const OllamaMonitor = lazy(() => import('./pages/OllamaMonitor'))
const Councils = lazy(() => import('./pages/Councils'))
const GBrain = lazy(() => import('./pages/GBrain'))

// Redirect shims: thin wrappers so old bookmarks keep working
const RedirectHome = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/" /> })
)
const RedirectCron = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/automations" /> })
)
const RedirectCosts = lazy(() =>
  Promise.resolve({ default: () => <Navigate replace to="/usage" /> })
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
  /** Sidebar group. Routes without a section (Overview) sit above the groups, unlabelled. */
  section?: 'operate' | 'know' | 'run'
  /** Plain-words subtitle, shown in the command palette. */
  description?: string
}

export const appRoutes: AppRouteDefinition[] = [
  { path: '/setup', label: 'Setup', module: 'settings', component: Setup, nav: false },
  { path: '/', label: 'Brain', module: 'dashboard', component: BrainHome, icon: BrainCircuit, navPlacement: 'primary', description: 'Is the brain healthy and does anything need you?' },
  { path: '/attention', label: 'Attention', module: 'attention', component: Attention, icon: Bell, navPlacement: 'primary', section: 'operate', description: 'What is waiting for you' },
  { path: '/automations', label: 'Automations', module: 'cron', component: Cron, icon: Clock, navPlacement: 'primary', section: 'operate', description: 'Scheduled jobs and their last runs' },
  { path: '/usage', label: 'Usage', module: 'costs', component: Costs, icon: DollarSign, navPlacement: 'primary', section: 'know', description: 'What you spent and on what' },
  { path: '/services', label: 'Services', module: 'services', component: Services, icon: Server, navPlacement: 'primary', section: 'run', description: 'Background services and gateways' },
  { path: '/ollama', label: 'Local models', module: 'ollamaMonitor', component: OllamaMonitor, icon: Brain, navPlacement: 'primary', section: 'run', description: 'Ollama health and loaded models' },
  { path: '/settings', label: 'Settings', module: 'settings', component: SettingsPage, icon: Settings, navPlacement: 'utility', description: 'Models, budget and appearance' },
  { path: '/councils', label: 'Audit', module: 'councils', component: Councils, icon: Landmark, navPlacement: 'utility', description: 'Past decisions and their votes' },
  // Reachable but not in the menu; the home page absorbs Knowledge later.
  { path: '/gbrain', label: 'Knowledge', module: 'gbrain', component: GBrain, icon: Search, nav: false, section: 'know', description: 'Is the brain healthy and in sync' },
  { path: '/calendar', label: 'Calendar', module: 'calendar', component: Calendar, icon: CalendarDays, nav: false, section: 'operate', description: 'Schedule' },
  // Compatibility redirects keep existing bookmarks working.
  { path: '/cron', label: 'Cron Jobs', module: 'cron', component: RedirectCron, nav: false },
  { path: '/costs', label: 'Cost Tracker', module: 'costs', component: RedirectCosts, nav: false },
  // Removed screens: their paths now land on the home page.
  { path: '/work', label: 'Work', module: 'workshop', component: RedirectHome, nav: false },
  { path: '/sessions', label: 'Sessions', module: 'chat', component: RedirectHome, nav: false },
  { path: '/systems', label: 'Agents', module: 'agents', component: RedirectHome, nav: false },
  { path: '/workshop', label: 'Workshop', module: 'workshop', component: RedirectHome, nav: false },
  { path: '/office', label: 'Digital Office', module: 'office', component: RedirectHome, nav: false },
  { path: '/team', label: 'Team Structure', module: 'team', component: RedirectHome, nav: false },
  { path: '/diagnostics', label: 'Diagnostics', module: 'settings', component: RedirectHome, nav: false },
  { path: '/kanban', label: 'Hermes Kanban', module: 'workshop', component: RedirectHome, nav: false },
  { path: '/conversations', label: 'Conversations', module: 'chat', component: RedirectHome, nav: false },
  { path: '/agents', label: 'Agent Hub', module: 'agents', component: RedirectHome, nav: false },
  { path: '/memory', label: 'Memory', module: 'docs', component: RedirectHome, nav: false },
  { path: '/scout', label: 'Scout', module: 'scout', component: RedirectHome, nav: false },
  { path: '/aws', label: 'AWS', module: 'aws', component: RedirectHome, nav: false },
  { path: '/skills', label: 'Skills', module: 'skills', component: RedirectHome, nav: false },
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
