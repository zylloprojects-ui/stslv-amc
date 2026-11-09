// Parts of the application that are built but not shown yet.

// Settings > Role list: the sign-in roles, where Super Admin adds, renames, deactivates and deletes custom roles
// (their permissions are set in Roles & Permissions). Enabled on feature/stslv-p2-improvements (2026-11-09) for
// custom-role management; shown only to people who may view Users & Access. Set to false to hide it again.
export const ROLE_LIST_ENABLED: boolean = true

// Settings > Organization > Divisions: hidden from the Settings navigation (2026-11-02). The panel, and anything
// stored about divisions, are kept; set this to true to show it again.
export const DIVISIONS_ENABLED: boolean = false
