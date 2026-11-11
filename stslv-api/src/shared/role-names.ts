// Display names of the built-in roles: the one place they are written down.
//
// Migration 0087 seeded them, and 0117 renamed three for the client (2026-11-11):
//   ADMINISTRATOR          Admin                 -> Service Dept
//   FINANCE_EXECUTIVE      Finance Executive     -> Accounts
//   MASTER_DATA_EXECUTIVE  Master Data Executive -> AMC Sales
//
// Screens, exports and API responses read roles.name from the database; API messages that name a role
// use these constants. Role codes never change, so assignments, grants, permission checks and audit
// history keep their meaning. stslv-web/src/auth/roleNames.ts holds the same names, and
// tests/role-display-names.test.ts checks that both files and the migrated database agree.
//
// No imports: permission-catalog.ts uses these, and role-model.ts imports permission-catalog.ts.

export const BUILT_IN_ROLE_NAMES = {
  ADMIN: "Super Admin",
  ADMINISTRATOR: "Service Dept",
  FINANCE_EXECUTIVE: "Accounts",
  MASTER_DATA_EXECUTIVE: "AMC Sales",
  AMC_OPERATIONS_EXECUTIVE: "AMC Operations Executive",
  VIEWER: "Viewer",
} as const;

/** The legacy roles of the first permission model (inactive since 0088); their names are unchanged. */
export const LEGACY_ROLE_NAMES = {
  ACCOUNTANT: "Accountant",
  PROCUREMENT: "Procurement",
  EXECUTION: "Execution",
  INVOICING: "Invoicing",
} as const;

/** "Super Admin and Service Dept": the two privileged roles, as messages name them. */
export const PRIVILEGED_ROLES_LABEL = `${BUILT_IN_ROLE_NAMES.ADMIN} and ${BUILT_IN_ROLE_NAMES.ADMINISTRATOR}`;
