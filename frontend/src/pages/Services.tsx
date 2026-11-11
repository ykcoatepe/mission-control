import { Page } from '../components/ui'
import ServicesView from './services/ServicesView'

export default function Services() {
  return (
    <Page title="Services" description="Is everything that should be running, running?">
      <ServicesView />
    </Page>
  )
}
