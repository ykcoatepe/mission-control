import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard,
  Hammer,
  DollarSign,
  Clock,
  Radar,
  Bot,
  MessageCircle,
  Settings,
  Puzzle,
  Cloud,
  CalendarDays,
  Brain,
  Building2,
  Landmark,
  Users2,
} from 'lucide-react'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const Chat = lazy(() => import('./pages/Chat'))
const Workshop = lazy(() => import('./pages/Workshop'))
const Costs = lazy(() => import('./pages/Costs'))
const Cron = lazy(() => import('./pages/Cron'))
const Scout = lazy(() => import('./pages/Scout'))
const Agents = lazy(() => import('./pages/Agents'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const Skills = lazy(() => import('./pages/Skills'))
const AWS = lazy(() => import('./pages/AWS'))
const Setup = lazy(() => import('./pages/Setup'))
const Calendar = lazy(() => import('./pages/Calendar'))
const OllamaMonitor = lazy(() => import('./pages/OllamaMonitor'))
const Councils = lazy(() => import('./pages/Councils'))
const TeamStructure = lazy(() => import('./pages/TeamStructure'))
const DigitalOffice = lazy(() => import('./pages/DigitalOffice'))
const Memory = lazy(() => import('./pages/Memory'))

type RouteComponent = LazyExoticComponent<ComponentType<any>>

export interface AppRouteDefinition {
  path: string
  label: string
  module: string
  component: RouteComponent
  icon?: LucideIcon
  nav?: boolean
}

export const appRoutes: AppRouteDefinition[] = [
  { path: '/setup', label: 'Setup', module: 'settings', component: Setup, nav: false },
  { path: '/', label: 'Dashboard', module: 'dashboard', component: Dashboard, icon: LayoutDashboard },
  { path: '/conversations', label: 'Conversations', module: 'chat', component: Chat, icon: MessageCircle },
  { path: '/workshop', label: 'Workshop', module: 'workshop', component: Workshop, icon: Hammer },
  { path: '/costs', label: 'Cost Tracker', module: 'costs', component: Costs, icon: DollarSign },
  { path: '/cron', label: 'Cron Jobs', module: 'cron', component: Cron, icon: Clock },
  { path: '/calendar', label: 'Calendar', module: 'calendar', component: Calendar, icon: CalendarDays },
  { path: '/ollama', label: 'Ollama Monitor', module: 'ollamaMonitor', component: OllamaMonitor, icon: Brain },
  { path: '/councils', label: 'Governance Archive', module: 'councils', component: Councils, icon: Landmark },
  { path: '/team', label: 'Team Structure', module: 'team', component: TeamStructure, icon: Users2 },
  { path: '/office', label: 'Digital Office', module: 'office', component: DigitalOffice, icon: Building2 },
  { path: '/memory', label: 'Memory', module: 'docs', component: Memory, icon: Brain },
  { path: '/scout', label: 'Scout', module: 'scout', component: Scout, icon: Radar },
  { path: '/agents', label: 'Agent Hub', module: 'agents', component: Agents, icon: Bot },
  { path: '/settings', label: 'Settings', module: 'settings', component: SettingsPage, icon: Settings },
  { path: '/skills', label: 'Skills', module: 'skills', component: Skills, icon: Puzzle, nav: false },
  { path: '/aws', label: 'AWS', module: 'aws', component: AWS, icon: Cloud },
]

export const sidebarRoutes = appRoutes.filter((route) => route.nav !== false && route.icon)
