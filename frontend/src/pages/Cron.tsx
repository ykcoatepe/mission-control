import { useSearchParams } from 'react-router-dom'
import { Page, Tabs, resolveTab } from '../components/ui'
import JobsView from './cron/JobsView'
import ScheduleView from './cron/ScheduleView'

type AutomationsView = 'jobs' | 'schedule'

const VIEW_TABS = [
  { id: 'jobs', label: 'Jobs' },
  { id: 'schedule', label: 'Schedule' },
]

interface AutomationsProps {
  /** View shown when the URL has no `view` parameter (the /calendar route opens the schedule). */
  defaultView?: AutomationsView
}

export default function Cron({ defaultView = 'jobs' }: AutomationsProps) {
  const [params] = useSearchParams()
  const view = resolveTab(VIEW_TABS, params.get('view'), defaultView)

  return (
    <Page
      title="Automations"
      description="Did your jobs run, and what runs next?"
      tabs={<Tabs tabs={VIEW_TABS} ariaLabel="Automations views" queryParam="view" defaultValue={defaultView} />}
    >
      {view === 'schedule' ? <ScheduleView /> : <JobsView />}
    </Page>
  )
}
