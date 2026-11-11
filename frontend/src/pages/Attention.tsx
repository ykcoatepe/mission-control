import { EmptyState, Page } from '../components/ui'

export default function Attention() {
  return (
    <Page title="Attention" description="What is waiting for you." width="narrow">
      <EmptyState
        title="This screen is being built"
        description="It will appear here once its readings are connected."
      />
    </Page>
  )
}
