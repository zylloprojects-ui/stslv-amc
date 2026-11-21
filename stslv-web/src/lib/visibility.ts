import type { SessionUser } from './types'

// Role visibility (owner request 2026-11-21): parts of a page hidden from the user's role in Roles & Permissions
// (a Dashboard row or panel, an Invoices column, an action). The API already leaves their data out and refuses
// hidden actions; the page only stops showing what is no longer sent. Keys: API shared/visibility-catalog.ts.

/** Whether a page item is visible to the signed-in user. An older API sends no list: everything is visible. */
export function shows(user: Pick<SessionUser, 'hidden'> | null | undefined, key: string): boolean {
  return !(user?.hidden ?? []).includes(key)
}
