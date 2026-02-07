import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Hammer,
  DollarSign,
  Clock,
  Radar,
  FileText,
  Bot,
  Activity,
  MessageCircle,
  Settings,
  Puzzle,
  Cloud
} from 'lucide-react'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/chat', icon: MessageCircle, label: 'Chat' },
  { to: '/workshop', icon: Hammer, label: 'Workshop' },
  { to: '/costs', icon: DollarSign, label: 'Cost Tracker' },
  { to: '/cron', icon: Clock, label: 'Cron Monitor' },
  { to: '/scout', icon: Radar, label: 'Scout' },
  { to: '/docs', icon: FileText, label: 'Doc Digest' },
  { to: '/agents', icon: Bot, label: 'Agent Hub' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/skills', icon: Puzzle, label: 'Skills' },
  { to: '/aws', icon: Cloud, label: 'AWS' },
]

export default function Sidebar() {
  return (
    <aside style={{ width: 256, height: '100vh', display: 'flex', flexDirection: 'column', position: 'relative' }} className="macos-sidebar">
      {/* Logo Section */}
      <div style={{ padding: '16px 16px 12px', position: 'relative', zIndex: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: '#007AFF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Activity size={16} style={{ color: '#fff' }} />
          </div>
          <div>
            <h1 style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.92)' }}>Mission Control</h1>
            <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', fontWeight: 500 }}>System Monitor</p>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="divider-h" style={{ margin: '0 16px', position: 'relative', zIndex: 2 }} />

      {/* Navigation */}
      <nav style={{ flex: 1, padding: '12px 12px 0', position: 'relative', zIndex: 2 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `macos-list-item ${isActive ? 'active' : ''}`
              }
              style={{ display: 'flex', alignItems: 'center', gap: 12 }}
            >
              <item.icon size={16} strokeWidth={2} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </div>
      </nav>

      {/* Divider */}
      <div className="divider-h" style={{ margin: '0 16px', position: 'relative', zIndex: 2 }} />

      {/* Footer */}
      <div style={{ padding: 16, position: 'relative', zIndex: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ position: 'relative' }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Bot size={16} style={{ color: 'rgba(255,255,255,0.65)' }} />
            </div>
            <span className="status-dot status-dot-green" style={{ position: 'absolute', top: -4, right: -4 }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.92)' }}>Zinbot</p>
            <p style={{ fontSize: 10, color: '#32D74B', fontWeight: 500 }}>Active</p>
          </div>
        </div>
      </div>
    </aside>
  )
}
