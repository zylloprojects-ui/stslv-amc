// Display names of the built-in roles, the same as the API (stslv-api/src/shared/role-names.ts; its
// tests/role-display-names.test.ts checks both files agree). Renamed for the client on 2026-11-11
// (migration 0117): Admin -> Service Dept, Finance Executive -> Accounts, Master Data Executive -> AMC Sales.
//
// Role lists, user rows, dropdowns and exports show the name the API sends (roles.name). These constants
// are for fixed text that names a role: help, hints and messages. Role codes never change.

export const BUILT_IN_ROLE_NAMES = {
  ADMIN: 'Super Admin',
  ADMINISTRATOR: 'Service Dept',
  FINANCE_EXECUTIVE: 'Accounts',
  MASTER_DATA_EXECUTIVE: 'AMC Sales',
  AMC_OPERATIONS_EXECUTIVE: 'AMC Operations Executive',
  VIEWER: 'Viewer',
} as const

/** The configurable administrator role (code ADMINISTRATOR). */
export const ADMINISTRATOR_NAME = BUILT_IN_ROLE_NAMES.ADMINISTRATOR
/** The built-in Finance section role (code FINANCE_EXECUTIVE). */
export const FINANCE_ROLE_NAME = BUILT_IN_ROLE_NAMES.FINANCE_EXECUTIVE
/** The built-in Master Data role (code MASTER_DATA_EXECUTIVE). */
export const MASTER_DATA_ROLE_NAME = BUILT_IN_ROLE_NAMES.MASTER_DATA_EXECUTIVE

/** "Super Admin and Service Dept": the two privileged roles, as fixed text names them. */
export const PRIVILEGED_ROLES_LABEL = `${BUILT_IN_ROLE_NAMES.ADMIN} and ${ADMINISTRATOR_NAME}`
