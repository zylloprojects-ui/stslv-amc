import { createContext, useContext } from 'react'
import type { Action, Module, SessionUser } from '../lib/types'

export interface AuthValue {
  /** loading: checking a stored session. error: the server could not be reached. */
  status: 'loading' | 'anonymous' | 'authenticated' | 'error'
  user: SessionUser | null
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  /** Replaces the stored token, for example after a password change. */
  replaceToken: (token: string) => void
  retry: () => void
  /**
   * Whether the signed-in user holds a permission. Used only to show or hide
   * controls: the API checks every request again and is the real protection.
   */
  can: (module: Module, action: Action) => boolean
}

export const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)

  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider.')
  }

  return value
}
