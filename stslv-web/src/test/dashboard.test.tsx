import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import { MetricCard } from '../pages/dashboard/MetricCard'
import { ACCOUNTANT, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply } from './helpers'

function dashboardApi(user: SessionUser, summary: () => MockReply | Promise<MockReply>) {
  signIn()

  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/dashboard/summary') return summary()
    return undefined
  })
}

// The shape GET /api/dashboard/summary returns to a user who may see everything.
const AMC = {
  asOf: '2026-10-01',
  contracts: { active: 12, activePastValidity: 3, draft: 1, expired: 0, cancelled: 2 },
  visits: { due: 7, overdue: 4, upcoming: 9, upcomingDays: 30, dueThisMonth: 11, inProgress: 1, postponed: 1, completedThisMonth: 2, completedTotal: 30 },
  invoicing: { readyForInvoice: { count: 5, amount: '12345.500' }, amountRequired: { count: 2 }, noInvoiceRequired: { count: 1 } },
}
const PROJECTS = {
  counts: { total: 20, active: 9, new: 4, inProgress: 5, completed: 8, cancelled: 3, readyForInvoice: 6, noInvoiceRequired: 1 },
  values: { totalJobValue: '90000.000', totalGrandValue: '94500.000', readyForInvoiceValue: '2000.250' },
  costs: { trackedExpenses: '4321.125', operationalJobMargin: '85678.875', trackedExpensesOnCancelledProjects: '40.000' },
}
const FULL = { clients: { active: 1234, inactive: 2 }, amc: AMC, projects: PROJECTS }
const SUMMARY = ok(FULL)

const ALL_LABELS = [
  'Active Clients',
  'Active Contracts',
  'Visits Due',
  'Ready for Invoice',
  'Active Projects',
  'Projects Ready for Invoice',
  'Tracked Expenses',
  'Ready-for-Invoice Value',
]

const withPermissions = (permissions: string[]): SessionUser => ({ ...ACCOUNTANT, permissions })

/** The card that holds a metric: its label is the card's heading. */
async function cardOf(label: string) {
  const heading = await screen.findByRole('heading', { name: label, level: 3 })

  return heading.closest('[data-metric-card]') as HTMLElement
}

const shownCards = () => screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)

describe('dashboard layout', () => {
  it('groups the metrics as Clients, AMC, Projects and Finance', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    const expected: Record<string, string[]> = {
      Clients: ['Active Clients'],
      AMC: ['Active Contracts', 'Visits Due', 'Ready for Invoice'],
      Projects: ['Active Projects', 'Projects Ready for Invoice'],
      Finance: ['Tracked Expenses', 'Ready-for-Invoice Value'],
    }

    for (const [group, labels] of Object.entries(expected)) {
      const section = await screen.findByRole('region', { name: group })
      const shown = within(section)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent)

      expect(shown).toEqual(labels)
    }
  })

  it('lays the cards out in a grid that narrows to one column on a phone', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    const grid = (await cardOf('Active Contracts')).parentElement as HTMLElement

    // One column by default, two from the small breakpoint, three on a wide screen.
    expect(grid).toHaveClass('grid', 'sm:grid-cols-2', 'xl:grid-cols-3')
    expect(grid.className).not.toMatch(/(^|\s)grid-cols-\d/)
  })

  it('shows the client figures from the API, formatted, with a link to the clients', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    const card = await cardOf('Active Clients')

    expect(await within(card).findByText('1,234')).toBeInTheDocument()
    expect(within(card).getByText('2 inactive')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'View clients' })).toHaveAttribute('href', '/clients')
    expect(within(card).queryByText('Not yet available')).not.toBeInTheDocument()
  })
})

describe('dashboard banner', () => {
  it('greets the user by name under the product name, with today’s date', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument()

    const main = screen.getByRole('main')
    expect(main).toHaveTextContent(/Good (morning|afternoon|evening), Asha Admin\./)
    expect(main).toHaveTextContent(new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))
    expect(main).toHaveTextContent('STSLEV AMC · Operations Suite')
    expect(main).not.toHaveTextContent('STSLEV ERP')
    expect(document.title).toBe('Dashboard · STSLEV AMC')
  })

  it('offers quick links only to pages the role may open', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    const admin = renderApp('/dashboard')

    await cardOf('Active Clients')
    const banner = () => screen.getByRole('heading', { name: 'Dashboard', level: 1 }).parentElement as HTMLElement

    expect(within(banner()).getByRole('link', { name: 'Clients' })).toHaveAttribute('href', '/clients')
    expect(within(banner()).getByRole('link', { name: 'Users & Access' })).toHaveAttribute('href', '/admin/users')
    admin.unmount()

    dashboardApi(ACCOUNTANT, () => ok({ clients: FULL.clients, amc: null, projects: PROJECTS }))
    renderApp('/dashboard')

    await cardOf('Active Clients')
    expect(within(banner()).getByRole('link', { name: 'Clients' })).toBeInTheDocument()
    expect(within(banner()).queryByRole('link', { name: 'Users & Access' })).not.toBeInTheDocument()
  })
})

describe('workspace cards', () => {
  const workspace = () => within(screen.getByRole('region', { name: 'Workspace' }))

  it('counts the modules the role may open, from the navigation', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    const admin = renderApp('/dashboard')

    await cardOf('Active Clients')
    // Every navigation item: the Admin may open them all.
    expect(workspace().getByText('Modules Available').nextElementSibling).toHaveTextContent(/^13$/)
    expect(workspace().getByText('Admin')).toBeInTheDocument()
    admin.unmount()

    dashboardApi(ACCOUNTANT, () => ok({ clients: FULL.clients, amc: null, projects: PROJECTS }))
    renderApp('/dashboard')

    await cardOf('Active Clients')
    // Dashboard, Clients, Projects and Expenses.
    expect(workspace().getByText('Modules Available').nextElementSibling).toHaveTextContent(/^4$/)
  })

  it('reports the connection from the dashboard’s own request, never as a fixed text', async () => {
    let release: (reply: MockReply) => void = () => {}
    dashboardApi(
      ADMIN,
      () =>
        new Promise<MockReply>((resolve) => {
          release = resolve
        }),
    )
    const pending = renderApp('/dashboard')

    await cardOf('Active Clients')
    expect(workspace().getByText('Checking…')).toBeInTheDocument()

    release(SUMMARY)
    expect(await workspace().findByText('Connected')).toBeInTheDocument()
    pending.unmount()

    dashboardApi(ADMIN, () => fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.'))
    renderApp('/dashboard')

    await screen.findByRole('alert')
    expect(await workspace().findByText('Unreachable')).toBeInTheDocument()
    expect(workspace().queryByText('Connected')).not.toBeInTheDocument()
  })

  it('draws the Active Clients ring only from figures the API returned', async () => {
    let release: (reply: MockReply) => void = () => {}
    dashboardApi(
      ADMIN,
      () =>
        new Promise<MockReply>((resolve) => {
          release = resolve
        }),
    )
    renderApp('/dashboard')

    const card = await cardOf('Active Clients')
    const arc = () => card.querySelector('circle[stroke^="url"]')

    // Nothing is drawn while the figures are still loading.
    expect(arc()).toBeNull()

    // 3 active of 4 clients: three quarters of the ring.
    release(ok({ ...FULL, clients: { active: 3, inactive: 1 } }))
    expect(await within(card).findByText('3')).toBeInTheDocument()

    const [filled, whole] = (arc()?.getAttribute('stroke-dasharray') ?? '').split(' ').map(Number)
    expect((filled as number) / (whole as number)).toBeCloseTo(0.75)
  })
})

describe('module rollout', () => {
  const tiles = () =>
    within(screen.getByRole('region', { name: 'Module rollout' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent)

  it('marks built modules Live and only the unbuilt ones Planned', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    await cardOf('Active Clients')

    expect(tiles()).toEqual([
      'ClientsLive',
      'AMC ContractsLive',
      'AMC ScheduleLive',
      'AMC ExecutionLive',
      'ProjectsLive',
      'ProcurementLive',
      'ExpensesLive',
      'Invoice TrackingPlanned',
      'ReportsPlanned',
      'Historical DataLive',
      'Users & AccessLive',
      'SettingsLive',
    ])
  })

  it('agrees with the pages: a Planned module opens a placeholder, a Live one opens its page', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    const planned = renderApp('/invoices')
    expect(await screen.findByText('Module implementation in progress')).toBeInTheDocument()
    planned.unmount()

    const live = renderApp('/settings')
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument()
    expect(screen.queryByText('Module implementation in progress')).not.toBeInTheDocument()
    live.unmount()
  })

  it('lists only the modules the role may open', async () => {
    dashboardApi(ACCOUNTANT, () => ok({ clients: FULL.clients, amc: null, projects: PROJECTS }))
    renderApp('/dashboard')

    await cardOf('Active Clients')

    expect(tiles()).toEqual(['ClientsLive', 'ProjectsLive', 'ExpensesLive'])
  })
})

describe('connected metrics', () => {
  it('shows the AMC figures the API returned', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    const contracts = await cardOf('Active Contracts')
    expect(await within(contracts).findByText('12')).toBeInTheDocument()
    expect(within(contracts).getByText('3 past validity')).toBeInTheDocument()
    expect(within(contracts).getByRole('link', { name: 'View contracts' })).toHaveAttribute('href', '/amc/contracts')

    const due = await cardOf('Visits Due')
    expect(within(due).getByText('7')).toBeInTheDocument()
    expect(within(due).getByText('4 overdue')).toBeInTheDocument()
    expect(within(due).getByRole('link', { name: 'View work list' })).toHaveAttribute('href', '/amc/execution')

    const ready = await cardOf('Ready for Invoice')
    expect(within(ready).getByText('5')).toBeInTheDocument()
    expect(within(ready).getByText('5 visits · 2 completed visits need an amount')).toBeInTheDocument()
  })

  it('shows the project and expense figures the API returned', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    const active = await cardOf('Active Projects')
    expect(await within(active).findByText('9')).toBeInTheDocument()
    expect(within(active).getByText('4 new, 5 in progress')).toBeInTheDocument()
    expect(within(active).getByRole('link', { name: 'View projects' })).toHaveAttribute('href', '/projects')

    const ready = await cardOf('Projects Ready for Invoice')
    expect(within(ready).getByText('6')).toBeInTheDocument()

    const expenses = await cardOf('Tracked Expenses')
    expect(within(expenses).getByText('4,321.125')).toBeInTheDocument()
    expect(within(expenses).getByText('Plus 40.000 on cancelled projects')).toBeInTheDocument()
    expect(within(expenses).getByRole('link', { name: 'View expenses' })).toHaveAttribute('href', '/expenses')
  })

  it('shows whatever the API returns: the figures are not fixed in the page', async () => {
    dashboardApi(ADMIN, () =>
      ok({
        clients: { active: 1, inactive: 0 },
        amc: {
          ...AMC,
          contracts: { ...AMC.contracts, active: 31, activePastValidity: 0 },
          visits: { ...AMC.visits, due: 0, overdue: 0 },
          invoicing: { ...AMC.invoicing, readyForInvoice: { count: 1, amount: '0.005' }, amountRequired: { count: 0 } },
        },
        projects: {
          ...PROJECTS,
          counts: { ...PROJECTS.counts, active: 44, new: 40, inProgress: 4, readyForInvoice: 1 },
          values: { ...PROJECTS.values, readyForInvoiceValue: '99999999999.999' },
          costs: { ...PROJECTS.costs, trackedExpenses: '0.000', trackedExpensesOnCancelledProjects: '0.000' },
        },
      }),
    )
    renderApp('/dashboard')

    const contracts = await cardOf('Active Contracts')
    expect(await within(contracts).findByText('31')).toBeInTheDocument()
    expect(within(contracts).queryByText(/past validity/)).not.toBeInTheDocument()

    // A real zero from the API is shown as a zero.
    expect(within(await cardOf('Visits Due')).getByText('0')).toBeInTheDocument()
    expect(within(await cardOf('Ready for Invoice')).getByText('1 completed visit')).toBeInTheDocument()
    expect(within(await cardOf('Active Projects')).getByText('44')).toBeInTheDocument()
    expect(within(await cardOf('Projects Ready for Invoice')).getByText('1 completed project')).toBeInTheDocument()

    const expenses = await cardOf('Tracked Expenses')
    expect(within(expenses).getByText('0.000')).toBeInTheDocument()
    expect(within(expenses).getByText('Cancelled projects left out')).toBeInTheDocument()

    // Amounts keep every digit: they are formatted as text, never through a JavaScript number.
    const value = await cardOf('Ready-for-Invoice Value')
    expect(within(value).getByText('0.005')).toBeInTheDocument()
    expect(within(value).getByText('99,999,999,999.999')).toBeInTheDocument()
  })

  it('shows no connected metric as "Not yet available"', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    await within(await cardOf('Ready-for-Invoice Value')).findByText('12,345.500')

    expect(shownCards()).toEqual(ALL_LABELS)
    expect(screen.queryByText('Not yet available')).not.toBeInTheDocument()
    expect(screen.queryByText(/no data source yet/)).not.toBeInTheDocument()
    // No figure card is drawn as an empty placeholder.
    expect(document.querySelector('[data-metric-card].border-dashed')).toBeNull()
  })
})

describe('ready-for-invoice value', () => {
  it('shows the AMC and project amounts as two separate values, each with its basis', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    const card = await cardOf('Ready-for-Invoice Value')
    const rows = (await within(card).findAllByRole('term')).map((term) => [term.textContent, (term.nextElementSibling as HTMLElement).textContent])

    expect(rows).toEqual([
      ['AMC As entered', '12,345.500'],
      ['Projects Excl. VAT', '2,000.250'],
    ])
    expect(within(card).getByText('Shown separately. The two amounts are not added together.')).toBeInTheDocument()
  })

  it('never shows a combined total', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    const card = await cardOf('Ready-for-Invoice Value')

    expect(await within(card).findByText('12,345.500')).toBeInTheDocument()
    expect(within(card).getByText('2,000.250')).toBeInTheDocument()
    // 12345.500 + 2000.250 would be 14345.750.
    expect(document.body.textContent).not.toMatch(/14,?345\.75/)
    expect(screen.queryByText(/total/i)).not.toBeInTheDocument()
  })

  it('lets the two values wrap onto separate lines on a narrow screen', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    const card = await cardOf('Ready-for-Invoice Value')

    for (const term of await within(card).findAllByRole('term')) {
      expect(term.parentElement).toHaveClass('flex', 'flex-wrap')
      expect(term.nextElementSibling).toHaveClass('min-w-0', 'break-words')
    }
  })

  it('shows only the project value to a role without the AMC schedule', async () => {
    dashboardApi(withPermissions(['DASHBOARD:VIEW', 'PROJECTS:VIEW']), () => ok({ clients: null, amc: null, projects: { ...PROJECTS, costs: null } }))
    renderApp('/dashboard')

    const card = await cardOf('Ready-for-Invoice Value')

    expect((await within(card).findAllByRole('term')).map((term) => term.textContent)).toEqual(['Projects Excl. VAT'])
    expect(within(card).getByText('2,000.250')).toBeInTheDocument()
    expect(within(card).queryByText('As entered')).not.toBeInTheDocument()
  })

  it('shows only the AMC value to a role without projects', async () => {
    dashboardApi(withPermissions(['DASHBOARD:VIEW', 'AMC_SCHEDULE:VIEW']), () =>
      ok({ clients: null, amc: { ...AMC, contracts: null }, projects: null }),
    )
    renderApp('/dashboard')

    const card = await cardOf('Ready-for-Invoice Value')

    expect((await within(card).findAllByRole('term')).map((term) => term.textContent)).toEqual(['AMC As entered'])
    expect(within(card).getByText('12,345.500')).toBeInTheDocument()
    expect(within(card).queryByText('Excl. VAT')).not.toBeInTheDocument()
  })
})

describe('a metric with no data source', () => {
  it('is marked "Not yet available" and never shows a number', () => {
    // No dashboard metric is in this state today. The card keeps it for a figure
    // whose module is not built yet (for example invoiced amounts).
    render(
      <MemoryRouter>
        <MetricCard
          metric={{ id: 'invoices.pending', label: 'Pending Invoices', visible: () => true, source: 'Invoice Tracking' }}
          state={{ kind: 'unavailable' }}
        />
      </MemoryRouter>,
    )

    const card = screen.getByRole('heading', { name: 'Pending Invoices' }).closest('[data-metric-card]') as HTMLElement

    expect(within(card).getByText('Not yet available')).toBeInTheDocument()
    expect(card.textContent).not.toMatch(/\d/)
  })
})

describe('dashboard states', () => {
  it('shows a loading placeholder until the figures arrive', async () => {
    let release: (reply: MockReply) => void = () => {}
    dashboardApi(
      ADMIN,
      () =>
        new Promise<MockReply>((resolve) => {
          release = resolve
        }),
    )
    renderApp('/dashboard')

    const card = await cardOf('Active Clients')

    expect(within(card).getByRole('status')).toHaveTextContent('Loading Active Clients')
    // No figure of any kind is on the page before the API answers.
    for (const label of ALL_LABELS) {
      expect((await cardOf(label)).textContent, label).not.toMatch(/\d/)
    }

    release(SUMMARY)

    expect(await within(card).findByText('1,234')).toBeInTheDocument()
    expect(within(card).queryByRole('status')).not.toBeInTheDocument()
  })

  it('reports a failure without inventing a figure, and recovers on retry', async () => {
    let failing = true
    dashboardApi(ADMIN, () => (failing ? fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.') : SUMMARY))
    renderApp('/dashboard')

    expect(await screen.findByRole('alert')).toHaveTextContent('The dashboard figures could not be loaded. An unexpected error occurred.')

    for (const label of ALL_LABELS) {
      const failed = await cardOf(label)

      expect(within(failed).getByText('Could not be loaded.')).toBeInTheDocument()
      expect(failed.textContent, label).not.toMatch(/\d/)
    }

    const card = await cardOf('Active Clients')

    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await within(card).findByText('1,234')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reads the figures again when Refresh is pressed', async () => {
    let active = 4
    const api = dashboardApi(ADMIN, () => ok({ ...FULL, clients: { active, inactive: 0 } }))
    renderApp('/dashboard')

    const card = await cardOf('Active Clients')
    await within(card).findByText('4')

    active = 5
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(await within(card).findByText('5')).toBeInTheDocument()
    expect(api.find('GET', '/dashboard/summary')).toHaveLength(2)
  })
})

describe('dashboard permissions', () => {
  it('shows a role only the metrics of modules it may view', async () => {
    // What the API returns to this role: no AMC figures, projects with costs.
    dashboardApi(ACCOUNTANT, () => ok({ clients: FULL.clients, amc: null, projects: PROJECTS }))
    renderApp('/dashboard')

    await within(await cardOf('Active Clients')).findByText('1,234')

    expect(shownCards()).toEqual(['Active Clients', 'Active Projects', 'Projects Ready for Invoice', 'Tracked Expenses', 'Ready-for-Invoice Value'])
    expect(screen.queryByRole('region', { name: 'AMC' })).not.toBeInTheDocument()
  })

  it('hides a figure the role does not include, even if the API were to send it', async () => {
    dashboardApi(ACCOUNTANT, () => SUMMARY)
    renderApp('/dashboard')

    await within(await cardOf('Active Clients')).findByText('1,234')

    expect(screen.queryByRole('region', { name: 'AMC' })).not.toBeInTheDocument()
    // The AMC amount is not shown in the value card either.
    expect(within(await cardOf('Ready-for-Invoice Value')).queryByText('As entered')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('12,345.500')
  })

  it('hides a card whose figure the API left out, instead of showing a zero', async () => {
    // The role appears to include everything, but the API is the authority and returned less.
    dashboardApi(ADMIN, () =>
      ok({
        clients: null,
        amc: { ...AMC, contracts: null, invoicing: null },
        projects: { ...PROJECTS, costs: null },
      }),
    )
    renderApp('/dashboard')

    await within(await cardOf('Visits Due')).findByText('7')

    expect(shownCards()).toEqual(['Visits Due', 'Active Projects', 'Projects Ready for Invoice', 'Ready-for-Invoice Value'])
    expect(screen.queryByRole('region', { name: 'Clients' })).not.toBeInTheDocument()
    expect(screen.queryByText('Not yet available')).not.toBeInTheDocument()
    expect(within(await cardOf('Ready-for-Invoice Value')).queryByText('As entered')).not.toBeInTheDocument()
  })

  it('shows Visits Due to a role with the execution work list only, and no amounts', async () => {
    dashboardApi(withPermissions(['DASHBOARD:VIEW', 'AMC_EXECUTION:VIEW']), () =>
      ok({ clients: null, amc: { ...AMC, contracts: null, invoicing: null }, projects: null }),
    )
    renderApp('/dashboard')

    const due = await cardOf('Visits Due')

    expect(await within(due).findByText('7')).toBeInTheDocument()
    expect(within(due).getByRole('link', { name: 'View work list' })).toHaveAttribute('href', '/amc/execution')
    expect(shownCards()).toEqual(['Visits Due'])
  })

  it('links Visits Due to the schedule for a role without the work list', async () => {
    dashboardApi(withPermissions(['DASHBOARD:VIEW', 'AMC_SCHEDULE:VIEW']), () => ok({ clients: null, amc: { ...AMC, contracts: null }, projects: null }))
    renderApp('/dashboard')

    const due = await cardOf('Visits Due')

    expect(await within(due).findByRole('link', { name: 'View schedule' })).toHaveAttribute('href', '/amc/schedule')
    expect(shownCards()).toEqual(['Visits Due', 'Ready for Invoice', 'Ready-for-Invoice Value'])
  })

  it('does not show Tracked Expenses without both the projects and the expenses permission', async () => {
    dashboardApi(withPermissions(['DASHBOARD:VIEW', 'EXPENSES:VIEW']), () => ok({ clients: null, amc: null, projects: null }))
    renderApp('/dashboard')

    expect(await screen.findByText('No figures to show')).toBeInTheDocument()
    expect(shownCards()).toEqual([])
  })

  it('does not tie any metric to the Invoice Tracking permission', async () => {
    dashboardApi(withPermissions(['DASHBOARD:VIEW', 'INVOICES:VIEW', 'INVOICES:EDIT']), () => SUMMARY)
    renderApp('/dashboard')

    expect(await screen.findByText('No figures to show')).toBeInTheDocument()
    expect(shownCards()).toEqual([])
  })

  it('explains an empty dashboard to a role with no reporting module', async () => {
    dashboardApi(withPermissions(['DASHBOARD:VIEW']), () => ok({ clients: null, amc: null, projects: null }))
    renderApp('/dashboard')

    const empty = (await screen.findByText('No figures to show')).parentElement as HTMLElement

    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
    expect(document.querySelector('[data-metric-card]')).toBeNull()
    // No business figure is invented: the only numbers on the page are today's date and
    // the count of modules this role may open (just the dashboard itself).
    expect(empty.textContent).not.toMatch(/\d/)
    expect(within(screen.getByRole('region', { name: 'Workspace' })).getByText('Modules Available').nextElementSibling).toHaveTextContent(/^1$/)
    expect(screen.queryByRole('region', { name: 'Module rollout' })).not.toBeInTheDocument()
  })
})
