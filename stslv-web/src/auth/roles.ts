import type { SessionUser } from '../lib/types'

// The six-role model (API: shared/role-model.ts). The Super Admin role keeps the code ADMIN.

/** Super Admin: fixed full access. */
export const ADMIN_ROLE_CODE = 'ADMIN'
/** Admin: configured by Super Admin; manages the other roles and their users. */
export const ADMINISTRATOR_ROLE_CODE = 'ADMINISTRATOR'

/** Roles whose holders only Super Admin may manage. The API enforces the same. */
export const isPrivilegedRole = (code: string) => code === ADMIN_ROLE_CODE || code === ADMINISTRATOR_ROLE_CODE

export function isSuperAdmin(user: SessionUser | null): boolean {
  return user?.roles.some((role) => role.code === ADMIN_ROLE_CODE) ?? false
}

/** Super Admin or Admin: the pages reserved to administrators (Audit Log, Suggestions Review). The API checks the same. */
export function isAdmin(user: SessionUser | null): boolean {
  return user?.roles.some((role) => isPrivilegedRole(role.code)) ?? false
}
