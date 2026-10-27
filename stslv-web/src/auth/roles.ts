import type { SessionUser } from '../lib/types'

/** The built-in Admin role. Some pages (the activity log) are reserved to it; the API checks the same. */
export const ADMIN_ROLE_CODE = 'ADMIN'

export function isAdmin(user: SessionUser | null): boolean {
  return user?.roles.some((role) => role.code === ADMIN_ROLE_CODE) ?? false
}
