import { Link } from 'react-router-dom'
import { EmptyState, usePublishPageTitle } from './ui'

/** An address that is no page of this app: say so, and give the way back. */
export default function NotFound() {
  usePublishPageTitle('Page not found')
  return (
    <EmptyState
      title="Page not found"
      description="There is no page at this address."
      action={<Link to="/">Back to Brain</Link>}
    />
  )
}
