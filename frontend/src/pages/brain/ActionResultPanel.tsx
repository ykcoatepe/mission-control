import { useEffect, useState } from 'react'
import { Button, Mono, Panel, StatePill } from '../../components/ui'
import { reportCopyText, reportState, reportStateLabel, type ActionReport } from '../gbrain/report'
import type { DiagnosticFinding } from '../gbrain/types'
import styles from './ActionResultPanel.module.css'

function Findings({ items, omitted }: { items: DiagnosticFinding[]; omitted: number }) {
  return (
    <>
      <ul className={styles.findings}>
        {items.map((finding, index) => (
          <li key={`${finding.name ?? 'check'}-${index}`} className={styles.finding}>
            <Mono>{finding.name || 'Unnamed check'}</Mono>
            {finding.message && <span className={styles.message}>{finding.message}</span>}
          </li>
        ))}
      </ul>
      {omitted > 0 && <p className={styles.more}>{omitted} more not listed.</p>}
    </>
  )
}

/**
 * What a check found. A check that ran and found problems is a result with a state, never a failed action:
 * a failure (could not run, timed out, unreadable) is the status notice and never reaches this panel.
 */
export function ActionResultPanel({ report, onDismiss }: { report: ActionReport; onDismiss: () => void }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (copy === 'idle') return
    const timer = window.setTimeout(() => setCopy('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [copy])

  const { result } = report
  const state = reportState(report)
  const failingOmitted = result.counts.failingOmitted ?? 0
  const warningOmitted = result.counts.warningOmitted ?? 0

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(reportCopyText(report))
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <Panel
      aria-label={`${report.label} result`}
      title={report.label}
      description={report.summary}
      actions={
        <>
          <StatePill state={state} label={reportStateLabel(report)} />
          <Button size="sm" onClick={onCopy}>
            {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy summary'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </>
      }
    >
      {result.healthScore !== null && (
        <p className={styles.score}>
          Health score <Mono>{result.healthScore}/100</Mono>
        </p>
      )}
      {result.failing.length > 0 && (
        <section className={styles.group} aria-label="Failing checks">
          <h3 className={styles.heading}>
            {result.counts.failing === 1 ? '1 check failing' : `${result.counts.failing} checks failing`}
          </h3>
          <Findings items={result.failing} omitted={failingOmitted} />
        </section>
      )}
      {result.warning.length > 0 && (
        <details className={styles.warnings}>
          <summary>{result.counts.warning === 1 ? '1 warning' : `${result.counts.warning} warnings`}</summary>
          <Findings items={result.warning} omitted={warningOmitted} />
        </details>
      )}
      {report.outcome === 'clean' && result.healthScore === null && <p className={styles.quiet}>Nothing to act on.</p>}
    </Panel>
  )
}
