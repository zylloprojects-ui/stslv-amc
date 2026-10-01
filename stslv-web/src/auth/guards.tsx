import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Button, FullPageMessage, Spinner } from '../components/ui'
import type { Action, Module } from '../lib/types'
import { useAuth } from './context'

/** Wraps every route that needs a signed-in user. */
export function ProtectedRoute() {
  const auth = useAuth()
  const location = useLocation()

  if (auth.status === 'loading') {
    return (
      <FullPageMessage>
        <Spinner label="Loading STSLV AMC" />
      </FullPageMessage>
    )
  }

  if (auth.status === 'error') {
    return (
      <FullPageMessage>
        <h1 className="text-lg font-semibold text-slate-900">Cannot reach the server</h1>
        <p className="mt-2 text-sm text-slate-600">Your session could not be checked. Make sure the API is running, then try again.</p>
        <div className="mt-5 flex justify-center gap-3">
          <Button onClick={auth.retry}>Try again</Button>
          <Button variant="secondary" onClick={auth.logout}>
            Sign out
          </Button>
        </div>
      </FullPageMessage>
    )
  }

  if (auth.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <Outlet />
}

/** Shows its children only to users holding the permission; otherwise an access-denied message. */
export function RequirePermission({ module, action = 'VIEW', children }: { module: Module; action?: Action; children: ReactNode }) {
  const auth = useAuth()

  if (!auth.can(module, action)) {
    return <AccessDenied />
  }

  return <>{children}</>
}

export function AccessDenied() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-slate-900">Access denied</h1>
      <p className="mt-2 text-sm text-slate-600">
        Your role does not include access to this page. If you need it, ask an administrator to update your role.
      </p>
    </div>
  )
}
