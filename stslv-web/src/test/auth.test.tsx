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

    // Sign out sits in the account menu in the header.
    await userEvent.click(await screen.findByRole('button', { name: /Account menu: Asha Admin/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(localStorage.getItem('stslv-amc.token')).toBeNull()
  })

  it('also signs out from the sidebar', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    await userEvent.click(within(nav).getByRole('button', { name: 'Sign Out' }))

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
  const linkNames = (nav: HTMLElement) =>
    within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent)

  /** The sidebar is an accordion: one group is open at a time, so each group is opened in turn. */
  async function linksByGroup(nav: HTMLElement): Promise<Record<string, (string | null)[]>> {
    // Dashboard at the top and Settings at the bottom are always shown; a group adds its own links between them.
    const always = linkNames(nav)
    const groups: Record<string, (string | null)[]> = {}

    for (const heading of within(nav).getAllByRole('heading')) {
      await userEvent.click(within(heading).getByRole('button'))
      groups[heading.textContent ?? ''] = linkNames(nav).filter((name) => !always.includes(name))
    }

    return groups
  }

  it('shows every section to an Admin', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    const nav = await screen.findByRole('navigation', { name: 'Main' })

    // Settings sits in the footer, after the groups.
    expect(linkNames(nav)).toEqual(['Dashboard', 'Settings'])
    expect(await linksByGroup(nav)).toEqual({
      Operations: ['Clients', 'AMC Contracts', 'AMC Schedule', 'AMC Execution', 'Projects', 'Procurement'],
      Finance: ['Expenses', 'Invoice Tracking'],
      Reporting: ['Reports', 'Historical Data'],
      Administration: ['Users & Access', 'Roles & Permissions'],
    })
  })

  it('opens only one group at a time', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    expect(within(nav).queryByRole('link', { name: 'Clients' })).not.toBeInTheDocument()

    await userEvent.click(within(nav).getByRole('button', { name: 'Operations' }))
    expect(within(nav).getByRole('button', { name: 'Operations' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav).getByRole('link', { name: 'Clients' })).toBeInTheDocument()

    await userEvent.click(within(nav).getByRole('button', { name: 'Finance' }))
    expect(within(nav).getByRole('link', { name: 'Expenses' })).toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: 'Clients' })).not.toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Operations' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('starts with the group of the current page open', async () => {
    session(ADMIN)
    renderApp('/reports')

    const nav = await screen.findByRole('navigation', { name: 'Main' })

    expect(within(nav).getByRole('button', { name: 'Reporting' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav).getByRole('link', { name: 'Reports' })).toHaveAttribute('aria-current', 'page')
  })

  it('shows a restricted role only the modules it may view', async () => {
    session(ACCOUNTANT)
    renderApp('/dashboard')

    const nav = await screen.findByRole('navigation', { name: 'Main' })

    // No Settings link: the role may not view it.
    expect(linkNames(nav)).toEqual(['Dashboard'])
    expect(await linksByGroup(nav)).toEqual({ Operations: ['Clients', 'Projects'], Finance: ['Expenses'] })
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
    renderApp('/reports')

    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument()
    expect(screen.getByText('Module implementation in progress')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('dashboard', () => {
  it('shows the real client counts, and no card for a figure the API did not return', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    const clientsCard = (await screen.findByText('Active Clients')).parentElement as HTMLElement
    expect(await within(clientsCard).findByText('4')).toBeInTheDocument()
    expect(within(clientsCard).getByText(/1 inactive/)).toBeInTheDocument()

    // The summary above carries client counts only. The other metrics are connected
    // to the API, so without a figure from it they are left out: no placeholder, no zero.
    for (const label of [
      'Active Contracts',
      'Visits Due',
      'Ready for Invoice',
      'Active Projects',
      'Projects Ready for Invoice',
      'Tracked Expenses',
      'Ready-for-Invoice Value',
    ]) {
      expect(screen.queryByRole('heading', { name: label, level: 3 })).not.toBeInTheDocument()
    }
    expect(screen.queryByText('Not yet available')).not.toBeInTheDocument()
  })
})

describe('cookie notice', () => {
  function sessionWithoutConsent() {
    localStorage.setItem('stslv-amc.token', 'test-token')
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.path === '/dashboard/summary') return summary
      return undefined
    })
  }

  it('appears after sign-in and is remembered once accepted', async () => {
    sessionWithoutConsent()
    renderApp('/dashboard')

    const dialog = await screen.findByRole('dialog', { name: 'Cookie Policy' })
    expect(dialog).toHaveTextContent('STSLEV AMC stores a small amount of information')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Accept All' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Cookie notice' })).not.toBeInTheDocument()
    expect(localStorage.getItem('stslev.cookie-consent')).toBe('all')
  })

  it('minimises to a bar that can be declined, and returns on the next visit if left', async () => {
    sessionWithoutConsent()
    renderApp('/dashboard')

    const dialog = await screen.findByRole('dialog', { name: 'Cookie Policy' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Minimise' }))

    const bar = await screen.findByRole('region', { name: 'Cookie notice' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(bar).getByText('We use cookies')).toBeInTheDocument()
    expect(localStorage.getItem('stslev.cookie-consent')).toBeNull()

    await userEvent.click(within(bar).getByRole('button', { name: 'Decline' }))
    expect(screen.queryByRole('region', { name: 'Cookie notice' })).not.toBeInTheDocument()
    expect(localStorage.getItem('stslev.cookie-consent')).toBe('essential')
  })

  it('reopens the full policy from the bar Settings button', async () => {
    sessionWithoutConsent()
    renderApp('/dashboard')

    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Cookie Policy' })).getByRole('button', { name: 'Minimise' }))
    await userEvent.click(within(await screen.findByRole('region', { name: 'Cookie notice' })).getByRole('button', { name: 'Settings' }))

    expect(await screen.findByRole('dialog', { name: 'Cookie Policy' })).toBeInTheDocument()
  })

  it('is not shown on the login page', async () => {
    mockApi(() => undefined)
    renderApp('/login')

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('colour theme', () => {
  it('lets the user pick a palette and remembers it', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Colour theme' }))
    await userEvent.click(screen.getByRole('button', { name: /Sky Light/ }))

    expect(document.documentElement.dataset.palette).toBe('sky')
    expect(localStorage.getItem('stslev.palette')).toBe('sky')
  })

  it('switches to dark mode and back, and remembers the choice', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Switch to dark mode' }))

    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('stslev.theme')).toBe('dark')

    await userEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }))

    expect(document.documentElement).not.toHaveClass('dark')
    expect(localStorage.getItem('stslev.theme')).toBe('light')
  })
})

describe('sidebar', () => {
  it('minimises to icons, remembers it, and expands again when a group is chosen', async () => {
    session(ADMIN)
    renderApp('/clients')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'Clients' })).toBeInTheDocument()

    await userEvent.click(within(nav).getByRole('button', { name: 'Minimise sidebar' }))

    expect(localStorage.getItem('stslev.sidebar-collapsed')).toBe('1')
    expect(within(nav).queryByRole('link', { name: 'Clients' })).not.toBeInTheDocument()
    // Every control keeps its name for screen readers while only its icon is shown.
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Sign Out' })).toBeInTheDocument()

    await userEvent.click(within(nav).getByRole('button', { name: 'Operations' }))

    expect(localStorage.getItem('stslev.sidebar-collapsed')).toBe('0')
    expect(within(nav).getByRole('link', { name: 'Clients' })).toBeInTheDocument()
  })
})

describe('page search', () => {
  it('opens the chosen page and keeps its name in the search box', async () => {
    signIn()
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ADMIN })
      if (request.path === '/dashboard/summary') return summary
      if (request.path === '/clients') return ok({ items: [], total: 0, page: 1, pageSize: 25 })
      return undefined
    })
    renderApp('/dashboard')

    const box = await screen.findByRole('combobox', { name: 'Search pages' })
    await userEvent.type(box, 'clien')
    await userEvent.click(within(await screen.findByRole('option', { name: /Clients/ })).getByRole('button'))

    expect(await screen.findByRole('heading', { name: 'Clients' })).toBeInTheDocument()
    expect(box).toHaveValue('Clients')

    // The sidebar follows: the page's group opens and the page is marked as current.
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'Clients' })).toHaveAttribute('aria-current', 'page')

    // Focusing again lists the pages with the current one marked.
    await userEvent.click(box)
    const options = await screen.findAllByRole('option')
    expect(options.length).toBeGreaterThan(1)
    expect(within(screen.getByRole('option', { name: /Clients/ })).getByLabelText('Selected')).toBeInTheDocument()
  })

  it('offers only the pages the role may view', async () => {
    session(ACCOUNTANT)
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('combobox', { name: 'Search pages' }))

    const options = (await screen.findAllByRole('option')).map((option) => option.querySelector('span.font-semibold')?.textContent)
    expect(options).toEqual(['Dashboard', 'Clients', 'Projects', 'Expenses', 'My Account'])
  })
})

describe('loader style', () => {
  it('lets the user pick a loader design and remembers it', async () => {
    session(ADMIN)
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Colour theme' }))
    await userEvent.click(screen.getByRole('button', { name: /Skeleton/ }))

    expect(localStorage.getItem('stslev.loader')).toBe('skeleton')
    expect(screen.getByRole('button', { name: /Skeleton/ })).toHaveAttribute('aria-pressed', 'true')

    // The choice lives in a store shared by every loader; put it back for the tests that follow.
    await userEvent.click(screen.getByRole('button', { name: /Logo ring/ }))
  })
})

describe('suggestions popup', () => {
  it('opens from the header, asks for enough detail, and says plainly that nothing is sent', async () => {
    const api = session(ADMIN)
    renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Suggestions and improvements' }))
    const dialog = await screen.findByRole('dialog', { name: 'Suggestions & Improvements' })
    expect(dialog).toHaveTextContent('propose an improvement for STSLEV AMC.')

    await userEvent.type(within(dialog).getByLabelText('Description'), 'short')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit Feedback' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('at least 10 characters')

    const before = api.requests.length
    await userEvent.type(within(dialog).getByLabelText('Description'), ' but now long enough')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit Feedback' }))

    expect(dialog).toHaveTextContent('Suggestions are not stored or sent yet.')
    expect(api.requests).toHaveLength(before)
  })
})
