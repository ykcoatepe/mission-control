import { Route, Routes } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import { appRoutes } from '../appRoutes'
import NotFound from './NotFound'

/** Every page of the app by its path; an unknown path lands on the "Page not found" state. */
export default function AppRouteTable({ location }: { location?: Location }) {
  return (
    <Routes location={location}>
      {appRoutes.map((route) => {
        const Component = route.component
        return <Route key={route.path} path={route.path} element={<Component />} />
      })}
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
