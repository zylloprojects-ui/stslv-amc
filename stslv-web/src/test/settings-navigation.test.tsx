import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { NAVIGATION, navItemVisible } from '../layout/navigation'
import type { SessionUser } from '../lib/types'
import { ADMIN, mockApi, ok, renderApp, signIn, type MockRequest } from './helpers'

// Security Center and Backup & Restore moved from the Administration menu into Settings, reusing the same pages.

const FINANCE: SessionUser = { ...ADMIN, id: '9', roles: [{ id: '9', code: 'FINANCE_EXECUTIVE', name: 'Finance Executive' }], permissions: ['DASHBOARD:VIEW', 'SETTINGS:VIEW', 'ACCOUNTS:VIEW'] }

const BACKUPS = {
  status: { available: false, unavailableReason: 'Not configured.', automaticSchedule: false, storageConfigured: false, storageDeclaredDurable: false, toolVersion: null, checks: [] },
  items: [],
}

function api(user: SessionUser) {
  signIn()

  return mockApi((request: MockRequest) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/security/backups') return ok(BACKUPS)
    if (request.path === '/dashboard/readiness') return ok({ checks: [] })
    if (request.path === '/security/events') return ok({ items: [], total: 0, page: 1, pageSize: 25 })
    return undefined
  })
}

const sections = () => screen.findByRole('navigation', { name: 'Settings sections' })
const groupOf = async (title: string) => (await within(await sections()).findByText(title)).parentElement as HTMLElement

describe('Administration menu', () => {
  it('no longer lists Security Center or Backup & Restore', () => {
    const items = NAVIGATION.find((section) => section.title === 'Administration')?.items.filter((item) => !item.settingsArea && item.path !== '/settings')

    expect(items?.map((item) => item.label)).toEqual(['Users & Access', 'Roles & Permissions', 'Login History', 'Audit Log', 'Recycle Bin', 'Suggestions Review'])
  })

  it('keeps both findable in page search, for administrators only', () => {
    const hidden = NAVIGATION.flatMap((section) => section.items).filter((item) => item.settingsArea)

    expect(hidden.map((item) => item.path)).toEqual(['/settings/security', '/settings/backups'])
    const canAll = () => true

    expect(hidden.every((item) => navItemVisible(item, canAll, true))).toBe(true)
    expect(hidden.some((item) => navItemVisible(item, canAll, false))).toBe(false)
  })
})

describe('Settings', () => {
  it('has one navigation: no horizontal toolbar, and both pages last under System', async () => {
    api(ADMIN)
    renderApp('/settings')

    await sections()
    expect(screen.queryByRole('navigation', { name: 'Settings areas' })).not.toBeInTheDocument()
    expect(screen.queryByText('General Settings')).not.toBeInTheDocument()
    expect(within(await groupOf('System')).getAllByRole('button').map((button) => button.textContent)).toEqual(['System status', 'Business settings', 'Security Center', 'Backup & Restore'])
    // The personal Security section stays under My settings, and is a different item.
    expect(within(await groupOf('My settings')).getAllByRole('button').map((button) => button.textContent)).toEqual(['Profile', 'Preferences', 'Security'])
  })

  it('opens each page at its own address, in the same layout, with the item selected', async () => {
    api(ADMIN)
    renderApp('/settings')

    await userEvent.click(within(await sections()).getByRole('button', { name: 'Security Center' }))
    expect(await screen.findByRole('heading', { name: 'Security Center', level: 2 })).toBeInTheDocument()
    expect(window.location.pathname === '/settings/security' || within(await sections()).getByRole('button', { name: 'Security Center' }).getAttribute('aria-current') === 'page').toBe(true)
    expect(within(await sections()).getByRole('button', { name: 'Security Center' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument()

    await userEvent.click(within(await sections()).getByRole('button', { name: 'Backup & Restore' }))
    expect(await screen.findByRole('heading', { name: 'Backup & Restore', level: 2 })).toBeInTheDocument()
    expect(within(await sections()).getByRole('button', { name: 'Backup & Restore' })).toHaveAttribute('aria-current', 'page')
    expect(within(await sections()).getByRole('button', { name: 'Security Center' })).not.toHaveAttribute('aria-current')

    await userEvent.click(within(await sections()).getByRole('button', { name: 'Security' }))
    expect(await screen.findByRole('heading', { name: 'Security', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Backup & Restore' })).not.toBeInTheDocument()
  })

  it('keeps Settings marked in the sidebar on every page', async () => {
    api(ADMIN)
    renderApp('/settings/backups')

    const main = await screen.findByRole('navigation', { name: 'Main' })
    await waitFor(() => expect(within(main).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page'))
  })

  it.each([
    ['/admin/security', 'Security Center'],
    ['/admin/backups', 'Backup & Restore'],
  ])('redirects the old link %s to the same page', async (from, name) => {
    api(ADMIN)
    renderApp(from)

    expect(await screen.findByRole('heading', { name, level: 2 })).toBeInTheDocument()
    expect(within(await sections()).getByRole('button', { name })).toHaveAttribute('aria-current', 'page')
  })

  it('cannot open an administrator page through ?section=', async () => {
    api(ADMIN)
    renderApp('/settings?section=backups')

    await sections()
    expect(screen.queryByRole('heading', { name: 'Backup & Restore' })).not.toBeInTheDocument()
    expect(within(await sections()).getByRole('button', { name: 'Profile' })).toHaveAttribute('aria-current', 'page')
  })

  it('offers neither item to someone who is not an administrator', async () => {
    api(FINANCE)
    renderApp('/settings')

    const nav = within(await sections())
    expect(nav.getByRole('button', { name: 'Business settings' })).toBeInTheDocument()
    expect(nav.queryByRole('button', { name: 'Security Center' })).not.toBeInTheDocument()
    expect(nav.queryByRole('button', { name: 'Backup & Restore' })).not.toBeInTheDocument()
  })

  it.each(['/settings/security', '/settings/backups', '/admin/security', '/admin/backups'])('keeps a non-administrator out of %s', async (path) => {
    const calls = api(FINANCE)
    renderApp(path)

    await screen.findByRole('navigation', { name: 'Main' })
    expect(screen.queryByRole('heading', { name: 'Security Center' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Backup & Restore' })).not.toBeInTheDocument()
    expect(calls.find('GET', '/security/backups')).toHaveLength(0)
    expect(calls.find('GET', '/security/events')).toHaveLength(0)
  })
})
