import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { NAVIGATION, navItemVisible } from '../layout/navigation'
import type { Action, Module, SessionUser } from '../lib/types'
import { ContractLink } from '../components/ContractLink'
import { InvoicesTable } from '../pages/invoices/InvoicesTable'
import { AuthContext, type AuthValue } from '../auth/context'
import { MemoryRouter } from 'react-router-dom'
import { amcApi, CLIENTS, makeContract } from './amc-helpers'
import { ADMIN, fail, mockApi, ok, renderApp, signIn } from './helpers'

// Cross-module permissions (2026-10-31): the sidebar, the route guards and the actions follow the
// saved permissions, not the role's name. The API enforces the same rules (API test of the same name).

const finance = (permissions: string[]): SessionUser => ({
  ...ADMIN,
  id: '40',
  roles: [{ id: '7', code: 'FINANCE_EXECUTIVE', name: 'Finance Executive' }],
  permissions,
})

const STARTING = ['DASHBOARD:VIEW', 'INVOICES:VIEW', 'INVOICES:CREATE', 'INVOICES:EDIT', 'INVOICES:EXPORT', 'ACCOUNTS:VIEW', 'ACCOUNTS:EXPORT', 'AMC_SCHEDULE:READ']

function session(user: SessionUser) {
  signIn()
  return mockApi((request) => (request.path === '/auth/me' ? ok({ user }) : undefined))
}

describe('Finance Executive and AMC Schedule', () => {
  it('denies the page without View, Data read alone', async () => {
    session(finance(STARTING))
    renderApp('/amc/schedule')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
  })

  it('opens the page and shows the sidebar item with View', async () => {
    session(finance([...STARTING, 'AMC_SCHEDULE:VIEW']))
    renderApp('/amc/schedule')

    await screen.findByRole('banner')
    expect(await screen.findByRole('link', { name: 'AMC Schedule' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Access denied' })).not.toBeInTheDocument()
  })

  // The rule behind the sidebar and header search: collapsed groups hide links from a rendered check.
  it('offers exactly the pages the saved permissions open', () => {
    const offered = (permissions: string[]) => {
      const held = new Set(permissions)
      const can = (module: Module, action: Action) => held.has(`${module}:${action}`)
      const canRead = (module: Module) => can(module, 'VIEW') || can(module, 'READ')

      return NAVIGATION.flatMap((section) => section.items)
        .filter((item) => navItemVisible(item, can, false, canRead))
        .map((item) => item.label)
    }

    expect(offered(STARTING)).toEqual(['Dashboard', 'Invoice Tracking', 'Accounts'])
    expect(offered([...STARTING, 'AMC_SCHEDULE:VIEW'])).toEqual(['Dashboard', 'AMC Schedule', 'Invoice Tracking', 'Accounts'])
    expect(offered(['INVOICES:VIEW'])).toEqual(['Invoice Tracking'])
    // Master AMC Status and Accounts: only on their own permission.
    expect(offered(['MASTER_AMC_STATUS:VIEW'])).toEqual(['Master AMC Status'])
    expect(offered(['ACCOUNTS:VIEW'])).toEqual(['Accounts'])
    expect(offered(['AMC_SCHEDULE:VIEW', 'SERVICES_SALES:VIEW', 'INVOICES:VIEW', 'AMC_SCHEDULE:READ'])).toEqual(['AMC Schedule', 'Services Sales', 'Invoice Tracking'])
    expect(offered(['SUGGESTIONS_REVIEW:VIEW'])).toEqual(['Suggestions Review'])
    expect(offered(['SETTINGS:VIEW'])).toEqual(['Settings'])
    expect(offered([])).toEqual([])
  })
})

describe('an open session', () => {
  it('re-reads its permissions after a refused request', async () => {
    signIn()
    const user = finance([...STARTING, 'AMC_SCHEDULE:VIEW'])
    const api = mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user })
      return request.path.startsWith('/amc/visits') ? fail(403, 'FORBIDDEN', 'No access') : undefined
    })
    renderApp('/amc/schedule')

    await waitFor(() => expect(api.find('GET', '/auth/me').length).toBeGreaterThanOrEqual(2))
  })
})

describe('the start page', () => {
  it('is the first page the role may open when it has no Dashboard', async () => {
    session(finance(['INVOICES:VIEW']))
    const { router } = renderApp('/')

    await waitFor(() => expect(router.state.location.pathname).toBe('/invoices'))
    expect(screen.queryByRole('heading', { name: 'Access denied' })).not.toBeInTheDocument()
  })

  it('is Access denied for a role with no page at all', async () => {
    session(finance([]))
    renderApp('/')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
  })
})

describe('calls to other modules', () => {
  it('does not ask for Dashboard figures on AMC Schedule without Dashboard', async () => {
    const api = session(finance(['AMC_SCHEDULE:VIEW']))
    renderApp('/amc/schedule')

    await screen.findByRole('banner')
    expect(api.find('GET', '/dashboard/summary')).toHaveLength(0)
  })
})

describe('Master AMC Status and Accounts routes', () => {
  it.each([
    ['/amc/master-status', ['MASTER_AMC_STATUS:VIEW'], ['AMC_SCHEDULE:VIEW', 'SERVICES_SALES:VIEW', 'INVOICES:VIEW']],
    ['/finance/accounts', ['ACCOUNTS:VIEW'], ['INVOICES:VIEW', 'AMC_SCHEDULE:VIEW']],
  ])('%s opens on its own permission, and not on the others', async (path, own, others) => {
    session(finance(own))
    const opened = renderApp(path)
    await screen.findByRole('banner')
    expect(screen.queryByRole('heading', { name: 'Access denied' })).not.toBeInTheDocument()
    opened.unmount()

    session(finance(others))
    renderApp(path)
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
  })
})

describe('suggestion permissions', () => {
  it('hides the submit button without Create', async () => {
    session(finance(['DASHBOARD:VIEW', 'SUGGESTIONS:VIEW']))
    renderApp('/dashboard')
    await screen.findByRole('banner')
    expect(screen.queryByRole('button', { name: 'Suggestions and improvements' })).not.toBeInTheDocument()
  })

  it('shows the submit button with Create', async () => {
    session(finance(['DASHBOARD:VIEW', 'SUGGESTIONS:VIEW', 'SUGGESTIONS:CREATE']))
    renderApp('/dashboard')
    expect(await screen.findByRole('button', { name: 'Suggestions and improvements' })).toBeInTheDocument()
  })

  it('denies My Suggestions without View, and Suggestions Review without its own View', async () => {
    session(finance(['DASHBOARD:VIEW', 'SUGGESTIONS_REVIEW:VIEW']))
    const first = renderApp('/suggestions')
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    first.unmount()

    session(finance(['DASHBOARD:VIEW', 'SUGGESTIONS:VIEW']))
    renderApp('/admin/suggestions')
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
  })
})

/** Renders with exactly these permissions, without a whole page around it. */
function withPermissions(permissions: string[], children: ReactNode) {
  const held = new Set(permissions)
  const value = {
    can: (module: Module, action: Action) => held.has(`${module}:${action}`),
    canRead: (module: Module) => held.has(`${module}:VIEW`) || held.has(`${module}:READ`),
  } as unknown as AuthValue

  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter>{children}</MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('ContractLink', () => {
  it('links to the contract for someone who may open it', () => {
    withPermissions(['AMC_CONTRACTS:VIEW'], <ContractLink id="7" aria-label="Open contract AMC-0007">AMC-0007</ContractLink>)
    expect(screen.getByRole('link', { name: 'Open contract AMC-0007' })).toHaveAttribute('href', '/amc/contracts/7')
  })

  it('shows the reference as plain text otherwise', () => {
    withPermissions(['AMC_SCHEDULE:VIEW'], <ContractLink id="7">AMC-0007</ContractLink>)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('AMC-0007')).toBeInTheDocument()
  })

  it('shows nothing for an action link otherwise', () => {
    withPermissions(['AMC_SCHEDULE:VIEW'], <ContractLink id="7" hideWithoutAccess>Open contract</ContractLink>)
    expect(screen.queryByText('Open contract')).not.toBeInTheDocument()
  })
})

describe('invoice numbers on data-only read', () => {
  const invoice = { id: '5', invoiceNumber: 'INV-5', invoiceDate: '2027-01-05', totalAmount: '10.000', status: 'ISSUED', client: { id: '1', name: 'C' }, source: 'ZOHO', allocations: [], amountExclVat: '10.000', vatAmount: '0.000' }
  const table = (<InvoicesTable items={[invoice as never]} showClient={false} canEdit={false} onDialog={() => undefined} />)

  it('lists the number without the button that opens the invoice, on Data read', () => {
    withPermissions(['INVOICES:READ'], table)
    expect(screen.getByText('INV-5')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View invoice INV-5' })).not.toBeInTheDocument()
  })

  it('offers the button with View', () => {
    withPermissions(['INVOICES:VIEW'], table)
    expect(screen.getByRole('button', { name: 'View invoice INV-5' })).toBeInTheDocument()
  })
})

describe('the contract form without client permissions', () => {
  it('lists clients from the narrow lookup and never calls the Clients list', async () => {
    const api = amcApi(finance(['AMC_CONTRACTS:VIEW', 'AMC_CONTRACTS:CREATE']), { contracts: [makeContract()] })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Add Contract' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add AMC Contract' })
    const select = await within(dialog).findByRole('combobox', { name: /Client/ })

    expect(within(select).getByRole('option', { name: CLIENTS[0]?.name ?? '' })).toBeInTheDocument()
    expect(api.find('GET', '/amc/contracts/client-options')).toHaveLength(1)
    expect(api.find('GET', '/clients')).toHaveLength(0)
  })

  it('offers no way to add a contract without Create', async () => {
    const api = amcApi(finance(['AMC_CONTRACTS:VIEW']), { contracts: [makeContract()] })
    renderApp('/amc/contracts')

    await screen.findByRole('table', { name: 'AMC contracts' })
    expect(screen.queryByRole('button', { name: 'Add Contract' })).not.toBeInTheDocument()
    expect(api.find('GET', '/amc/contracts/client-options')).toHaveLength(0)
  })
})

describe('contract status filters without Dashboard', () => {
  it('stay available from their own figures', async () => {
    const figures = { active: 3, activePastValidity: 0, draft: 1, expired: 0, cancelled: 0 }
    const api = amcApi(finance(['AMC_CONTRACTS:VIEW']), {
      contracts: [makeContract()],
      override: (request) => (request.path === '/amc/contracts/status-summary' ? ok({ contracts: figures }) : undefined),
    })
    renderApp('/amc/contracts')

    expect(await screen.findByRole('group', { name: 'Filter contracts by status' })).toBeInTheDocument()
    expect(api.find('GET', '/dashboard/summary')).toHaveLength(0)
  })
})

describe('notification links', () => {
  it('shows Open only where the user can open the page', async () => {
    const alert = (key: string, title: string, link: string | null) => ({ key, severity: 'warning', title, message: 'Message', link, count: 1, isRead: false, readAt: null, pinned: false })
    signIn()
    mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: finance(['AMC_EXECUTION:VIEW']) })
      if (request.path === '/notifications') return ok({ items: [alert('a', 'Can open', '/amc/execution'), alert('b', 'Cannot open', null)], unreadCount: 2 })
      return undefined
    })
    renderApp('/notifications')

    await screen.findByText('Cannot open')
    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(1)
  })
})
