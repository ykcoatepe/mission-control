import { DollarSign, TrendingUp, TrendingDown, Target } from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, BarChart, Bar,
  CartesianGrid
} from 'recharts'
import PageTransition from '../components/PageTransition'
import GlassCard from '../components/GlassCard'
import AnimatedCounter from '../components/AnimatedCounter'
import { useApi } from '../lib/hooks'

const COLORS = ['#818cf8', '#c084fc', '#34d399', '#fbbf24', '#f87171', '#60a5fa']

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'rgba(30,30,32,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '8px 12px' }}>
      <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, marginBottom: 4 }}>{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: 'rgba(255,255,255,0.92)', fontSize: 14, fontWeight: 600 }}>${p.value?.toFixed(2)}</p>
      ))}
    </div>
  )
}

export default function Costs() {
  const { data, loading } = useApi<any>('/api/costs', 60000)

  if (loading || !data) {
    return (
      <PageTransition>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 256 }}>
          <div style={{ width: 32, height: 32, border: '2px solid #007AFF', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        </div>
      </PageTransition>
    )
  }

  const { daily, summary, byService } = data
  const budgetPct = ((summary.thisMonth / summary.budget.monthly) * 100).toFixed(1)

  return (
    <PageTransition>
      <div style={{ maxWidth: 1280, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
        {/* Header */}
        <div>
          <h1 className="text-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <DollarSign size={22} style={{ color: '#32D74B' }} /> Cost Tracker
          </h1>
          <p className="text-body" style={{ marginTop: 4 }}>Monitor spending across all services</p>
        </div>

        {/* Key Metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20 }}>
          {[
            { label: 'Today', value: summary.today, icon: DollarSign, prefix: '$', color: '#32D74B' },
            { label: 'This Week', value: summary.thisWeek, icon: TrendingUp, prefix: '$', color: '#007AFF' },
            { label: 'This Month', value: summary.thisMonth, icon: TrendingDown, prefix: '$', color: '#BF5AF2' },
            { label: 'Budget Used', value: parseFloat(budgetPct), icon: Target, suffix: '%', color: '#FF9500' },
          ].map((m, i) => (
            <GlassCard key={m.label} delay={i * 0.05} noPad>
              <div style={{ padding: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 12, background: `${m.color}20`, border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <m.icon size={18} style={{ color: m.color }} />
                  </div>
                  <span style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: '0.15em' }}>{m.label}</span>
                </div>
                <p style={{ fontSize: 24, fontWeight: 300, color: 'rgba(255,255,255,0.92)' }}>
                  <AnimatedCounter end={m.value} decimals={2} prefix={m.prefix || ''} suffix={m.suffix || ''} />
                </p>
              </div>
            </GlassCard>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
          {/* Spend Chart */}
          <GlassCard delay={0.15} hover={false} noPad>
            <div style={{ padding: 24 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.65)', marginBottom: 20 }}>Monthly Spend</h3>
              <div style={{ height: 256 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={daily}>
                    <defs>
                      <linearGradient id="costGradientLG" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#c084fc" stopOpacity={0.9} />
                        <stop offset="15%" stopColor="#a78bfa" stopOpacity={0.7} />
                        <stop offset="35%" stopColor="#e879f9" stopOpacity={0.5} />
                        <stop offset="60%" stopColor="#f472b6" stopOpacity={0.3} />
                        <stop offset="85%" stopColor="#fbbf24" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="costStroke" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#8b5cf6" stopOpacity={1} />
                        <stop offset="50%" stopColor="#ec4899" stopOpacity={1} />
                        <stop offset="100%" stopColor="#f59e0b" stopOpacity={1} />
                      </linearGradient>
                      <filter id="glow">
                        <feGaussianBlur stdDeviation="6" result="coloredBlur"/>
                        <feMerge>
                          <feMergeNode in="coloredBlur"/>
                          <feMergeNode in="SourceGraphic"/>
                        </feMerge>
                      </filter>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="date" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }} tickFormatter={(v) => v.slice(5)} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }} tickFormatter={(v) => `$${v}`} axisLine={false} tickLine={false} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="total" stroke="url(#costStroke)" strokeWidth={3} fill="url(#costGradientLG)" filter="url(#glow)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </GlassCard>

          {/* Service Breakdown */}
          <GlassCard delay={0.2} hover={false} noPad>
            <div style={{ padding: 24 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.65)', marginBottom: 20 }}>By Service</h3>
              <div style={{ height: 192, marginBottom: 16 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={byService} cx="50%" cy="50%" innerRadius={50} outerRadius={72} dataKey="cost" nameKey="name" strokeWidth={0}>
                      {byService.map((_: any, i: number) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} opacity={0.8} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {byService.map((s: any, i: number) => (
                  <div key={s.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, overflow: 'hidden' }}>
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: COLORS[i % COLORS.length], flexShrink: 0 }} />
                      <span style={{ color: 'rgba(255,255,255,0.65)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                    </div>
                    <span style={{ color: 'rgba(255,255,255,0.92)', fontWeight: 600 }}>${s.cost.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          </GlassCard>
        </div>

        {/* Budget Progress */}
        <GlassCard delay={0.25} hover={false} noPad>
          <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>Budget Utilization</h3>
              <span style={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.45)' }}>
                ${summary.thisMonth.toFixed(2)} / ${summary.budget.monthly}
              </span>
            </div>
            <div style={{ height: 14, borderRadius: 7, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%', borderRadius: 7,
                  width: `${Math.min(parseFloat(budgetPct), 100)}%`,
                  background: parseFloat(budgetPct) > 75
                    ? 'linear-gradient(to right, #FF9500, #FF453A)'
                    : 'linear-gradient(to right, #007AFF, #BF5AF2)',
                  transition: 'width 0.6s ease',
                }}
              />
            </div>
            {summary.thisMonth >= summary.budget.warning && (
              <p style={{ fontSize: 12, color: '#FF9500', marginTop: 10, fontWeight: 500 }}>⚠️ Approaching budget warning threshold</p>
            )}
          </div>
        </GlassCard>

        {/* Daily Cost Bars */}
        <GlassCard delay={0.3} hover={false} noPad>
          <div style={{ padding: 24 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.65)', marginBottom: 20 }}>Daily Breakdown</h3>
            <div style={{ height: 192 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily.slice(-14)}>
                  <defs>
                    <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#8b5cf6" stopOpacity={1} />
                      <stop offset="30%" stopColor="#a78bfa" stopOpacity={0.9} />
                      <stop offset="60%" stopColor="#6366f1" stopOpacity={0.7} />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.5} />
                    </linearGradient>
                    <filter id="barGlow">
                      <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
                      <feMerge>
                        <feMergeNode in="coloredBlur"/>
                        <feMergeNode in="SourceGraphic"/>
                      </feMerge>
                    </filter>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="date" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }} tickFormatter={(v) => v.slice(8)} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }} tickFormatter={(v) => `$${v}`} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="total" fill="url(#barGradient)" radius={[12, 12, 0, 0]} filter="url(#barGlow)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </GlassCard>
      </div>
    </PageTransition>
  )
}
