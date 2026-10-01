import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, getToken, setToken, setUnauthorizedHandler } from '../lib/api'
import type { Action, Module, SessionUser } from '../lib/types'
import { AuthContext, type AuthValue } from './context'

const ME_KEY = ['auth', 'me'] as const

interface LoginResponse {
  token: string
  user: SessionUser
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [token, setTokenState] = useState<string | null>(() => getToken())

  const logout = useCallback(() => {
    setToken(null)
    setTokenState(null)
    queryClient.clear()
  }, [queryClient])

  // Any request rejected with 401 ends the session.
  useEffect(() => {
    setUnauthorizedHandler(logout)
    return () => setUnauthorizedHandler(null)
  }, [logout])

  // The user and permissions always come from the API, and are refreshed
  // periodically so a role change by an administrator shows up without a new login.
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: () => api.get<{ user: SessionUser }>('/auth/me'),
    enabled: token !== null,
    staleTime: 60_000,
    retry: false,
  })

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api.post<LoginResponse>('/auth/login', { email, password })

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
      replaceToken,
      retry: () => void refetch(),
      can: (module: Module, action: Action) => permissions.has(`${module}:${action}`),
    }
  }, [token, user, me.isError, login, logout, replaceToken, refetch])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
