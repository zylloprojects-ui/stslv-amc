import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { NAVIGATION, navItemVisible } from '../layout/navigation'
import { usePageTitle } from '../components/hooks'
import { BrandLoader, Button, FullPageMessage } from '../components/ui'
import type { Action, Module } from '../lib/types'
import { useAuth } from './context'
import { isAdmin } from './roles'

/** Wraps every route that needs a signed-in user. */
export function ProtectedRoute() {
  const auth = useAuth()
  const location = useLocation()

  if (auth.status === 'loading') {
    return (
      <FullPageMessage>
        <BrandLoader label="Loading STSLEV AMC" size="lg" />
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

  // Signed in with a temporary password: nothing else until a new password is chosen.
  // The API refuses such a session everywhere else as well.
  if (auth.user?.credentialChangeRequired) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />
  }

  return <Outlet />
}

export const CHANGE_PASSWORD_PATH = '/change-password'

/** The start page: the first page in the navigation this user may open. With none, /dashboard explains Access denied. */
export function LandingRedirect() {
  const auth = useAuth()
  const first = NAVIGATION.flatMap((section) => section.items).find((item) => navItemVisible(item, auth.can, isAdmin(auth.user), auth.canRead))

  return <Navigate to={first?.path ?? '/dashboard'} replace />
}

/** Shows its children only to users holding the permission; otherwise an access-denied message. */
export function RequirePermission({ module, action = 'VIEW', children }: { module: Module; action?: Action; children: ReactNode }) {
  const auth = useAuth()

  if (!auth.can(module, action)) {
    return <AccessDenied />
  }

  return <>{children}</>
}

/** For a page that shows another module's data: View or data-only Read of that module. The API checks the same. */
export function RequireDataRead({ module, children }: { module: Module; children: ReactNode }) {
  const auth = useAuth()

  if (!auth.canRead(module)) {
    return <AccessDenied />
  }

  return <>{children}</>
}

/** Shows its children to users who may view at least one of the modules (a hub of several modules). */
export function RequireAnyPermission({ modules, children }: { modules: Module[]; children: ReactNode }) {
  const auth = useAuth()

  if (!modules.some((module) => auth.can(module, 'VIEW'))) {
    return <AccessDenied />
  }

  return <>{children}</>
}

/** For pages reserved to administrators (Super Admin and Admin). The API enforces the same rule. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const auth = useAuth()

  if (!isAdmin(auth.user)) {
    return <AccessDenied />
  }

  return <>{children}</>
}

export function AccessDenied() {
  usePageTitle('Access denied')

  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-slate-200 bg-white p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-slate-900">Access denied</h1>
      <p className="mt-2 text-sm text-slate-600">
        Your role does not include access to this page. If you need it, ask an administrator to update your role.
      </p>
    </div>
  )
}
