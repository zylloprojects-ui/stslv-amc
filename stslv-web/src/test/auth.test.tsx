import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ACCOUNTANT, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply } from './helpers'

const summary = ok({ clients: { active: 4, inactive: 1 } })

function session(user: typeof ADMIN) {
  signIn()
  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/dashboard/summary') return summary
    return undefined
  })
}

describe('login', () => {
  it('validates the form before calling the API', async () => {
    const api = mockApi(() => undefined)
    renderApp('/login')

    await userEvent.click(screen.getByRole('button', { name: 'Login' }))

    expect(await screen.findByText('Email is required.')).toBeInTheDocument()
    expect(screen.getByText('Password is required.')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/Email/), 'not-an-email')
    await userEvent.click(screen.getByRole('button', { name: 'Login' }))

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument()
    expect(api.requests).toHaveLength(0)
  })

  it('shows the failure and stays on the login page when the credentials are wrong', async () => {
    mockApi((request) =>
      request.path === '/auth/login' ? fail(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.') : undefined,
    )
    renderApp('/login')

    await userEvent.type(screen.getByLabelText(/Email/), 'admin@example.com')
    await userEvent.type(screen.getByLabelText(/Password/), 'wrong-password')
    await userEvent.click(screen.getByRole('button', { name: 'Login' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.')
    expect(screen.getByRole('button', { name: 'Login' })).toBeEnabled()
    expect(localStorage.getItem('stslv-amc.token')).toBeNull()
  })

  it('shows a loading state, then signs in and opens the dashboard', async () => {
    let release: (reply: MockReply) => void = () => {}
    const api = mockApi((request) => {
      if (request.path === '/auth/login') {
        return new Promise<MockReply>((resolve) => {
          release = resolve
        })
      }
      return request.path === '/dashboard/summary' ? summary : undefined
    })
    renderApp('/login')

    await userEvent.type(screen.getByLabelText(/Email/), 'admin@example.com')
    await userEvent.type(screen.getByLabelText(/Password/), 'a-good-password')
    await userEvent.click(screen.getByRole('button', { name: 'Login' }))

    expect(await screen.findByRole('button', { name: 'Signing in' })).toBeDisabled()

    release(ok({ token: 'issued-token', expiresAt: '2026-10-01T18:00:00.000Z', user: ADMIN }))

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(api.find('POST', '/auth/login')[0]?.body).toEqual({ email: 'admin@example.com', password: 'a-good-password' })
    expect(localStorage.getItem('stslv-amc.token')).toBe('issued-token')
    // Later requests carry the token.
    await waitFor(() => expect(api.find('GET', '/dashboard/summary')[0]?.authorization).toBe('Bearer issued-token'))
  })

  it('reports an unreachable server', async () => {
    mockApi(() => {
      throw new TypeError('Failed to fetch')
    })
    renderApp('/login')

    await userEvent.type(screen.getByLabelText(/Email/), 'admin@example.com')
    await userEvent.type(screen.getByLabelText(/Password/), 'a-good-password')
    await userEvent.click(screen.getByRole('button', { name: 'Login' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server')
  })
})

describe('protected routes', () => {
  it('sends a visitor without a session to the login page', async () => {
    const api = mockApi(() => undefined)
    renderApp('/clients')

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Clients' })).not.toBeInTheDocument()
    expect(api.requests).toHaveLength(0)
  })

  it('discards a session the API no longer accepts', async () => {
    signIn()
    mockApi((request) => (request.path === '/auth/me' ? fail(401, 'UNAUTHORIZED', 'Your session is no longer valid.') : undefined))
    renderApp('/dashboard')

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(localStorage.getItem('stslv-amc.token')).toBeNull()
  })

  it('restores a stored session and shows who is signed in', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    const header = screen.getByRole('banner')
    expect(within(header).getByText('Asha Admin')).toBeInTheDocument()
    expect(within(header).getByText('Admin')).toBeInTheDocument()
  })

  it('signs out, clears the session and returns to the login page', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(localStorage.getItem('stslv-amc.token')).toBeNull()
  })

  it('shows the account information of the signed-in user', async () => {
    session(ACCOUNTANT)
    renderApp('/account')

    expect(await screen.findByRole('heading', { name: 'My Account' })).toBeInTheDocument()
    const main = screen.getByRole('main')
    expect(within(main).getByText('Arun Accountant')).toBeInTheDocument()
    expect(within(main).getByText('accountant@example.com')).toBeInTheDocument()
    expect(within(main).getByText('Accountant')).toBeInTheDocument()
  })
})

describe('permission-based navigation', () => {
  const NAV_LABELS = [
    'Dashboard',
    'Clients',
    'AMC Contracts',
    'AMC Schedule',
    'AMC Execution',
    'Projects',
    'Procurement',
    'Expenses',
    'Invoice Tracking',
    'Reports',
    'Users & Access',
    'Settings',
  ]

  it('shows every section to an Admin', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const links = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent)

    expect(links).toEqual(NAV_LABELS)
    for (const group of ['Operations', 'Finance', 'Reporting', 'Administration']) {
      expect(within(nav).getByRole('heading', { name: group })).toBeInTheDocument()
    }
  })

  it('shows a restricted role only the modules it may view', async () => {
    session(ACCOUNTANT)
    renderApp('/dashboard')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const links = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent)

    expect(links).toEqual(['Dashboard', 'Clients', 'Projects', 'Expenses'])
    expect(within(nav).queryByRole('heading', { name: 'Administration' })).not.toBeInTheDocument()
  })

  it('refuses a page the role may not view, without requesting its data', async () => {
    const api = session(ACCOUNTANT)
    renderApp('/admin/users')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Users & Access' })).not.toBeInTheDocument()
    expect(api.find('GET', '/users')).toHaveLength(0)
  })

  it('shows unbuilt modules as in progress, with no data', async () => {
    session(ADMIN)
    renderApp('/amc/contracts')

    expect(await screen.findByRole('heading', { name: 'AMC Contracts' })).toBeInTheDocument()
    expect(screen.getByText('Module implementation in progress')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('dashboard', () => {
  it('shows the real client counts and no figures for modules that do not exist yet', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    const clientsCard = (await screen.findByText('Active Clients')).parentElement as HTMLElement
    expect(await within(clientsCard).findByText('4')).toBeInTheDocument()
    expect(within(clientsCard).getByText(/1 inactive/)).toBeInTheDocument()

    for (const label of ['Active AMC Contracts', 'Visits Due', 'Ready for Invoice', 'Active Projects', 'Project Costs', 'Pending Invoices']) {
      const card = screen.getByText(label).closest('div.border-dashed') as HTMLElement
      expect(within(card).getByText('Not yet available')).toBeInTheDocument()
      expect(card.textContent).not.toMatch(/\d/)
    }
  })
})
