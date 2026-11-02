import { createContext, useContext } from 'react'
import type { Action, Module, SessionUser } from '../lib/types'

export interface AuthValue {
  /** loading: checking a stored session. error: the server could not be reached. */
  status: 'loading' | 'anonymous' | 'authenticated' | 'error'
  user: SessionUser | null
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  /** Why the API ended the last session, when the user must be told (an expired temporary password). */
  signOutNotice: string | null
  clearSignOutNotice: () => void
  /** Replaces the stored token, for example after a password change. */
  replaceToken: (token: string) => void
  retry: () => void
  /**
   * Whether the signed-in user holds a permission. Used only to show or hide
   * controls: the API checks every request again and is the real protection.
   */
  can: (module: Module, action: Action) => boolean
  /**
   * Data-only read: View of the module, or its Read grant. Only for another section's page that
   * shows this module's data (a client picker, invoice numbers); the module's own pages need View.
   */
  canRead: (module: Module) => boolean
}

export const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)

  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider.')
  }

  return value
}
