import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NAVIGATION, navItemVisible } from '../layout/navigation'
import type { SessionUser } from '../lib/types'
import { ADMIN, mockApi, ok, renderApp, signIn } from './helpers'

// The page permission modules of migration 0080: the sidebar offers a page, and
// its route opens, only with that page's own module. A convenience only; the API
// refuses the same requests (stslv-api/tests/page-permissions.test.ts).

const userWith = (permissions: string[]): SessionUser => ({ ...ADMIN, id: '9', roles: [{ id: '9', code: 'CUSTOM', name: 'Custom' }], permissions })

function signInAs(user: SessionUser) {
  signIn()
  mockApi((request) => (request.path === '/auth/me' ? ok({ user }) : undefined))
}

/** The sidebar labels a user is offered, by the same rule the Sidebar applies. */
const sidebarLabels = (permissions: string[]) =>
  NAVIGATION.flatMap((section) => section.items)
    .filter((item) => navItemVisible(item, (module, action) => permissions.includes(`${module}:${action}`), false))
    .map((item) => item.label)

describe('pages with their own permission module', () => {
  it.each([
    ['MONTHLY_CALENDAR', 'Monthly Calendar', ['AMC Schedule', 'Service Status', 'AMC Renewal']],
    ['SERVICE_STATUS', 'Service Status', ['AMC Schedule', 'Monthly Calendar']],
    ['AMC_RENEWAL', 'AMC Renewal', ['AMC Contracts', 'AMC Management']],
    ['SYSTEM_TYPES', 'System Types', ['Sales Engineers', 'Departments', 'Maintenance Frequencies', 'Settings']],
  ])('offers only the %s page in the sidebar', (module, shown, hidden) => {
    const links = sidebarLabels([`${module}:VIEW`])

    expect(links).toContain(shown)
    for (const label of hidden) {
      expect(links, label).not.toContain(label)
    }
  })

  it.each([
    ['/amc/service-status', ['MONTHLY_CALENDAR:VIEW', 'AMC_SCHEDULE:VIEW']],
    ['/amc/calendar', ['SERVICE_STATUS:VIEW', 'AMC_SCHEDULE:VIEW']],
    ['/amc/renewal', ['AMC_CONTRACTS:VIEW', 'AMC_CONTRACTS:CREATE']],
    ['/master-data/departments', ['SETTINGS:VIEW', 'SALES_ENGINEERS:VIEW']],
    ['/master-data/sales-engineers', ['SETTINGS:VIEW', 'DEPARTMENTS:VIEW']],
  ])('refuses %s opened directly without its own module', async (path, permissions) => {
    signInAs(userWith(permissions))
    renderApp(path)

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
  })

  it('opens the Master Data Center for a user who may view only one master list', async () => {
    signInAs(userWith(['DEPARTMENTS:VIEW']))
    renderApp('/master-data')

    expect((await screen.findAllByRole('heading', { name: 'Master Data Center' })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { name: 'Access denied' })).not.toBeInTheDocument()
  })
})
