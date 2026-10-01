import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import { ACCOUNTANT, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply } from './helpers'

function dashboardApi(user: SessionUser, summary: () => MockReply | Promise<MockReply>) {
  signIn()

  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/dashboard/summary') return summary()
    return undefined
  })
}

const SUMMARY = ok({ clients: { active: 1234, inactive: 2 } })

/** The card that holds a metric: its label is the card's heading. */
async function cardOf(label: string) {
  const heading = await screen.findByRole('heading', { name: label, level: 3 })

  return heading.closest('div.rounded-lg') as HTMLElement
}

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

  it('shows the client figures from the API, formatted, with a link to the clients', async () => {
    dashboardApi(ADMIN, () => SUMMARY)
    renderApp('/dashboard')

    const card = await cardOf('Active Clients')

    expect(await within(card).findByText('1,234')).toBeInTheDocument()
    expect(within(card).getByText('2 inactive')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'View clients' })).toHaveAttribute('href', '/clients')
    expect(within(card).queryByText('Not yet available')).not.toBeInTheDocument()
  })

  it('never shows a number for a metric that has no data source, whatever the API sends', async () => {
    // Figures the dashboard has not been connected to must not appear by accident.
    dashboardApi(ADMIN, () =>
      ok({ clients: { active: 3, inactive: 0 }, amc: { activeContracts: 7, visitsDue: 9 }, projects: { active: 5 }, finance: { trackedExpenses: '100.000' } }),
    )
    renderApp('/dashboard')

    await within(await cardOf('Active Clients')).findByText('3')

    for (const label of ['Active Contracts', 'Visits Due', 'Ready for Invoice', 'Active Projects', 'Projects Ready for Invoice', 'Tracked Expenses', 'Ready-for-Invoice Value']) {
      const card = await cardOf(label)

      expect(within(card).getByText('Not yet available')).toBeInTheDocument()
      expect(card.textContent).not.toMatch(/\d/)
    }
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
    expect(card.textContent).not.toMatch(/\d/)

    release(SUMMARY)

    expect(await within(card).findByText('1,234')).toBeInTheDocument()
    expect(within(card).queryByRole('status')).not.toBeInTheDocument()
  })

  it('reports a failure without inventing a figure, and recovers on retry', async () => {
    let failing = true
    dashboardApi(ADMIN, () => (failing ? fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.') : SUMMARY))
    renderApp('/dashboard')

    expect(await screen.findByRole('alert')).toHaveTextContent('The dashboard figures could not be loaded. An unexpected error occurred.')

    const card = await cardOf('Active Clients')

    expect(within(card).getByText('Could not be loaded.')).toBeInTheDocument()
    expect(card.textContent).not.toMatch(/\d/)

    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await within(card).findByText('1,234')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reads the figures again when Refresh is pressed', async () => {
    let active = 4
    const api = dashboardApi(ADMIN, () => ok({ clients: { active, inactive: 0 } }))
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
    dashboardApi(ACCOUNTANT, () => SUMMARY)
    renderApp('/dashboard')

    await cardOf('Active Clients')

    const shown = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)

    expect(shown).toEqual(['Active Clients', 'Active Projects', 'Tracked Expenses'])
    expect(screen.queryByRole('region', { name: 'AMC' })).not.toBeInTheDocument()
  })

  it('explains an empty dashboard to a role with no reporting module', async () => {
    dashboardApi({ ...ACCOUNTANT, permissions: ['DASHBOARD:VIEW'] }, () => SUMMARY)
    renderApp('/dashboard')

    expect(await screen.findByText('No figures to show')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
  })
})
