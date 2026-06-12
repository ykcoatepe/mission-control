/* eslint-disable react-refresh/only-export-components */
import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Navigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Hammer,
  DollarSign,
  Clock,
  Bot,
  MessageCircle,
  Settings,
  CalendarDays,
  Brain,
  Building2,
  Landmark,
  Users2,
  Kanban,
  GitBranch,
  Wrench,
} from 'lucide-react'

const Dashboard = lazy(() => import('./pages/Dashboard'))
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

type RouteComponent = LazyExoticComponent<ComponentType>

export interface AppRouteDefinition {
  path: string
  label: string
  module: string
  component: RouteComponent
  icon?: LucideIcon
  nav?: boolean
  section?: 'operate' | 'intelligence' | 'system' | 'audit'
  description?: string
}

export const appRoutes: AppRouteDefinition[] = [
  { path: '/setup', label: 'Setup', module: 'settings', component: Setup, nav: false },
  { path: '/', label: 'Operator Briefing', module: 'dashboard', component: Dashboard, icon: LayoutDashboard, section: 'operate', description: 'Current call' },
  { path: '/office', label: 'Digital Office', module: 'office', component: DigitalOffice, icon: Building2, section: 'operate', description: 'Live desks' },
  { path: '/cron', label: 'Cron Jobs', module: 'cron', component: Cron, icon: Clock, section: 'operate', description: 'Automations' },
  { path: '/conversations', label: 'Conversations', module: 'chat', component: Chat, icon: MessageCircle, section: 'operate', description: 'Sessions' },
  { path: '/workshop', label: 'Workshop', module: 'workshop', component: Workshop, icon: Hammer, section: 'operate', description: 'Tasks' },
  { path: '/kanban', label: 'Hermes Kanban', module: 'workshop', component: HermesKanban, icon: Kanban, section: 'operate', description: 'Hermes board' },
  { path: '/costs', label: 'Cost Tracker', module: 'costs', component: Costs, icon: DollarSign, section: 'intelligence', description: 'Spend and model mix' },
  { path: '/calendar', label: 'Calendar', module: 'calendar', component: Calendar, icon: CalendarDays, section: 'intelligence', description: 'Schedule' },
  { path: '/gbrain', label: 'GBrain', module: 'docs', component: GBrain, icon: GitBranch, section: 'intelligence', description: 'Shared brain' },
  { path: '/diagnostics', label: 'Diagnostics', module: 'settings', component: Diagnostics, icon: Wrench, section: 'system', description: 'Memory, docs, scout, AWS' },
  { path: '/ollama', label: 'Ollama Monitor', module: 'ollamaMonitor', component: OllamaMonitor, icon: Brain, section: 'system', description: 'Local models' },
  { path: '/team', label: 'Team Structure', module: 'team', component: TeamStructure, icon: Users2, section: 'system', description: 'Agent map' },
  { path: '/agents', label: 'Agent Hub', module: 'agents', component: Agents, icon: Bot, section: 'system', description: 'Runtime controls' },
  { path: '/settings', label: 'Settings', module: 'settings', component: SettingsPage, icon: Settings, section: 'system', description: 'Configuration' },
  { path: '/councils', label: 'Governance Archive', module: 'councils', component: Councils, icon: Landmark, section: 'audit', description: 'Decision audit' },
  // Legacy redirects — nav:false keeps them out of the sidebar
  { path: '/memory', label: 'Memory', module: 'docs', component: RedirectMemory, nav: false },
  { path: '/scout', label: 'Scout', module: 'scout', component: RedirectScout, nav: false },
  { path: '/aws', label: 'AWS', module: 'aws', component: RedirectAWS, nav: false },
  { path: '/skills', label: 'Skills', module: 'skills', component: RedirectSkills, nav: false },
]

export const sidebarRoutes = appRoutes.filter((route) => route.nav !== false && route.icon)
