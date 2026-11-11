import { createContext, useContext } from 'react'

export type ToastTone = 'success' | 'error' | 'warning' | 'info'

export interface ToastOptions {
  /** Milliseconds before auto-dismiss. 0 keeps it until dismissed. Default 4000 (8000 for errors). */
  duration?: number
}

export interface ToastApi {
  /** Show the result of an action. Returns the toast id. */
  show: (tone: ToastTone, message: string, options?: ToastOptions) => number
  dismiss: (id: number) => void
}

export const ToastContext = createContext<ToastApi>({
  show: () => 0,
  dismiss: () => {},
})

export function useToast(): ToastApi {
  return useContext(ToastContext)
}
