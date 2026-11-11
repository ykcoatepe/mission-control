import Cron from './Cron'

/** The old Calendar route: the Automations page opened on its Schedule view. */
export default function CalendarPage() {
  return <Cron defaultView="schedule" />
}
