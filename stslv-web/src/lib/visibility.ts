import { useContext } from 'react'
import { AuthContext } from '../auth/context'
import type { SessionUser } from './types'

// Role visibility (owner request 2026-11-21): parts of a page hidden from the user's role in Roles & Permissions
// (a Dashboard row or panel, an Invoices column, an action). The API already leaves their data out and refuses
// hidden actions; the page only stops showing what is no longer sent. Keys: API shared/visibility-catalog.ts.

/** Whether a page item is visible to the signed-in user. An older API sends no list: everything is visible. */
export function shows(user: Pick<SessionUser, 'hidden'> | null | undefined, key: string): boolean {
  return !(user?.hidden ?? []).includes(key)
}

/**
 * Whether a column (and its form field) of a page is hidden from the user: `hiddenField(user, 'clients', 'email')`.
 * A hidden field is shown locked in its form and left out of the save; the API keeps its stored value.
 */
export function hiddenField(user: Pick<SessionUser, 'hidden'> | null | undefined, page: string, column: string): boolean {
  return !shows(user, `${page}.column.${column}`)
}

/**
 * The form fields of a page hidden from the signed-in user: `useHiddenFields('clients', { email: 'email' })` gives
 * ['email'] when the Email column is hidden. Outside a signed-in session nothing is hidden.
 */
export function useHiddenFields(page: string, fields: Record<string, string>): string[] {
  const user = useContext(AuthContext)?.user ?? null
  return Object.entries(fields)
    .filter(([column]) => hiddenField(user, page, column))
    .map(([, field]) => field)
}

/** The body of a save without the fields hidden from the user (never sent, so the stored values are kept). */
export function withoutHidden<T extends object>(body: T, hidden: readonly string[]): T {
  if (hidden.length === 0) return body
  return Object.fromEntries(Object.entries(body).filter(([field]) => !hidden.includes(field))) as T
}
