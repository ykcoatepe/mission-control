import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Button } from './ui/Button'
import { ErrorState } from './ui/ErrorState'

interface Props {
  /** When this value changes (e.g. the pathname), a caught error is cleared. */
  resetKey: string
  children: ReactNode
}

interface State {
  error: Error | null
  resetKey: string
}

/** Keeps a failing page inside the shell instead of blanking the app. */
export default class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey }
    return null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Mission Control] page failed to render', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          title="This page could not be shown"
          message={this.state.error.message}
          onRetry={() => window.location.reload()}
          retryLabel="Reload page"
          action={
            <Button variant="ghost" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          }
        />
      )
    }
    return this.props.children
  }
}
