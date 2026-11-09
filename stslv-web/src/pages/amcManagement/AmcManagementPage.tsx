import { DashboardPage } from '../DashboardPage'

// AMC Management shows the ONE shared Dashboard (client requirement, 2026-11-09): the very same component as
// /dashboard, with the same data (GET /api/dashboard/operations), cards, order, values, Oman-time dates, colours,
// sections, links, loading / empty / error states, permissions (DASHBOARD:VIEW, set on the route in App.tsx) and
// responsive layout. There is deliberately no second implementation here: change the Dashboard in DashboardPage.tsx
// (and pages/dashboard/*), and both routes change together.
//
// The earlier AMC Management page (its own KPI groups, Recent AMC Contracts and Expiry & Renewal panels, read from
// GET /api/amc/management/summary) is no longer shown. That API is kept, read only, for compatibility.

export function AmcManagementPage() {
  return <DashboardPage />
}
