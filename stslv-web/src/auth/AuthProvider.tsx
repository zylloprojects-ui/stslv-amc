import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, apiUrl, getToken, resetActivity, setForbiddenHandler, setToken, setUnauthorizedHandler } from '../lib/api'
import type { Action, Module, SessionUser } from '../lib/types'
import { AuthContext, type AuthValue } from './context'

const ME_KEY = ['auth', 'me'] as const

// How often an open session picks up changed permissions, and how soon after one refusal
// another refusal may ask again (a page can be refused several calls at once).
const PERMISSIONS_REFRESH_MS = 60_000
const REFUSAL_REFRESH_GAP_MS = 5_000

interface LoginResponse {
  token: string
  user: SessionUser
}

// Refusals whose message is shown on the sign-in page.
const EXPLAINED_SIGN_OUTS = new Set(['TEMPORARY_PASSWORD_EXPIRED', 'SESSION_IDLE_TIMEOUT', 'SESSION_REVOKED'])

/**
 * Tells the API the user signed out: it ends this session on the server (the token stops working everywhere) and
 * records the sign-out. Best effort: not awaited, every failure is ignored, and it bypasses the api client so a
 * refusal cannot end a newer session. The browser forgets the token either way.
 */
function recordSignOut(token: string): void {
  try {
    void fetch(apiUrl('/api/auth/logout'), {
      method: 'POST',
      keepalive: true,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => undefined)
  } catch {
    // Nothing to do: signing out never depends on this.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [token, setTokenState] = useState<string | null>(() => getToken())

  // Why the last session was ended by the API, when the user needs to be told.
  const [signOutNotice, setSignOutNotice] = useState<string | null>(null)

  const endSession = useCallback(() => {
    setToken(null)
    setTokenState(null)
    queryClient.clear()
  }, [queryClient])

  // The user chose to sign out. A session the API has already refused just ends (below).
  const logout = useCallback(() => {
    const current = getToken()

    if (current !== null) recordSignOut(current)
    endSession()
  }, [endSession])

  // Any request rejected with 401 ends the session. A temporary password that expired while the user was signed in
  // (for example on the change-password screen), the inactivity limit, or a sign-out from another device or by an
  // administrator is explained on the sign-in page instead of leaving them there without a reason.
  useEffect(() => {
    setUnauthorizedHandler((error) => {
      if (EXPLAINED_SIGN_OUTS.has(error.code) && getToken() !== null) {
        setSignOutNotice(error.message)
      }
      endSession()
    })
    return () => setUnauthorizedHandler(null)
  }, [endSession])

  // A refused request may mean the role has just lost a permission: refresh the sidebar and the
  // route guards now, not at the next periodic check. The API has already enforced the refusal.
  useEffect(() => {
    let last = 0
    setForbiddenHandler(() => {
      const now = Date.now()
      if (getToken() === null || now - last < REFUSAL_REFRESH_GAP_MS) return
      last = now
      void queryClient.invalidateQueries({ queryKey: ME_KEY })
    })
    return () => setForbiddenHandler(null)
  }, [queryClient])

  const clearSignOutNotice = useCallback(() => setSignOutNotice(null), [])

  // The user and permissions always come from the API, and are refreshed
  // periodically so a role change by an administrator shows up without a new login.
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: () => api.get<{ user: SessionUser }>('/auth/me'),
    enabled: token !== null,
    staleTime: PERMISSIONS_REFRESH_MS,
    refetchInterval: PERMISSIONS_REFRESH_MS,
    retry: false,
  })

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.post<LoginResponse>('/auth/login', { email, password })

      resetActivity()
      setSignOutNotice(null)
      setToken(result.token)
      queryClient.setQueryData(ME_KEY, { user: result.user })
      setTokenState(result.token)
    },
    [queryClient],
  )

  const replaceToken = useCallback((newToken: string) => {
    setToken(newToken)
    setTokenState(newToken)
  }, [])

  const user = token !== null ? (me.data?.user ?? null) : null
  const refetch = me.refetch

  const value = useMemo<AuthValue>(() => {
    const permissions = new Set(user?.permissions ?? [])
    let status: AuthValue['status']

    if (token === null) {
      status = 'anonymous'
    } else if (user) {
      status = 'authenticated'
    } else if (me.isError) {
      status = 'error'
    } else {
      status = 'loading'
    }

    return {
      status,
      user,
      login,
      logout,
      signOutNotice,
      clearSignOutNotice,
      replaceToken,
      retry: () => void refetch(),
      can: (module: Module, action: Action) => permissions.has(`${module}:${action}`),
      canRead: (module: Module) => permissions.has(`${module}:VIEW`) || permissions.has(`${module}:READ`),
    }
  }, [token, user, me.isError, login, logout, signOutNotice, clearSignOutNotice, replaceToken, refetch])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
