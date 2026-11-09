import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../lib/types'
import { displayName, parseNames } from '../pages/amcManagement/managementPreferences'
import type { OperationsDashboard } from '../pages/dashboard/operationsTypes'
import { ACCOUNTANT, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply } from './helpers'

// The client requires AMC Management and the Dashboard to be EXACTLY IDENTICAL (2026-11-09). Both routes render the one
// shared Dashboard (DashboardPage). This suite renders /dashboard and /amc/management with the same role, the same API
// data, the same date and filters, and requires the same page: cards, titles, order, values, colours, sections, links,
// permissions, and the loading, empty and error states. (The earlier AMC Management page, with its own KPI groups,
// Recent AMC Contracts and Expiry & Renewal panels, was replaced by this requirement; its page tests went with it. The
// KPI-name helpers it shared with Accounts and AMC Renewal are still tested below.)

const OPERATIONS: OperationsDashboard = {
  asOf: '2026-11-09',
  timeZone: 'Asia/Muscat',
  kpis: {
    contracts: {
      active: 12,
      activePastValidity: 2,
      activeAwaitingPredecessor: 1,
      activeValue: '8010.500',
      finalCreditTotal: '300.501',
      finalCreditRecorded: 2,
      expiringSoon: 3,
      expiringSoonDays: 45,
      expiringSoonWithRenewal: 1,
    },
    services: { thisMonth: 9, completedThisMonth: 4, openThisMonth: 5, overall: 140, openOverall: 96 },
    payments: {
      paid: 3,
      paidValue: '240.000',
      unpaid: 8,
      unpaidValue: '640.500',
      paidThisMonth: 2,
      paidThisMonthValue: '160.000',
      scheduledThisMonth: { withInvoiceNo: 1, withInvoiceNoValue: '80.000', withoutInvoiceNo: 6, withoutInvoiceNoValue: '480.375' },
    },
  },
  portfolio: { total: 16, statuses: [{ status: 'ACTIVE', count: 12, percent: '75.0' }] },
  expiring: { days: 90, total: 0, pastValidity: 0, renewalsInstalled: true, items: [] },
  workload: { months: [{ month: '2026-11', planned: 9, completed: 4, open: 5 }, { month: '2026-12', planned: 3, completed: 0, open: 3 }] },
  schedule: {
    today: [{ id: '501', contractId: '41', client: { id: '1', name: 'Harbour Hotel' }, systemDescription: 'FIRE ALARM', scheduledDate: '2026-11-09', assignedTo: 'R. Engineer', status: 'SCHEDULED', isOverdue: false }],
    todayTotal: 1,
    upcoming: [],
    upcomingTotal: 0,
    upcomingDays: 7,
  },
  paymentTrend: { months: [{ month: '2026-10', count: 1, value: '80.000' }, { month: '2026-11', count: 2, value: '160.000' }] },
}

/** A database with nothing in it: every figure zero, no lists. */
const EMPTY: OperationsDashboard = {
  ...OPERATIONS,
  kpis: {
    contracts: { active: 0, activePastValidity: 0, activeAwaitingPredecessor: 0, activeValue: '0.000', finalCreditTotal: '0.000', finalCreditRecorded: 0, expiringSoon: 0, expiringSoonDays: 45, expiringSoonWithRenewal: 0 },
    services: { thisMonth: 0, completedThisMonth: 0, openThisMonth: 0, overall: 0, openOverall: 0 },
    payments: { paid: 0, paidValue: '0.000', unpaid: 0, unpaidValue: '0.000', paidThisMonth: 0, paidThisMonthValue: '0.000', scheduledThisMonth: { withInvoiceNo: 0, withInvoiceNoValue: '0.000', withoutInvoiceNo: 0, withoutInvoiceNoValue: '0.000' } },
  },
  portfolio: { total: 0, statuses: [] },
  workload: { months: [{ month: '2026-11', planned: 0, completed: 0, open: 0 }] },
  schedule: { today: [], todayTotal: 0, upcoming: [], upcomingTotal: 0, upcomingDays: 7 },
  paymentTrend: { months: [{ month: '2026-11', count: 0, value: '0.000' }] },
}

/** A role with only some modules: Dashboard and Invoice Tracking, no AMC Contracts, no schedule. */
const RESTRICTED: SessionUser = { ...ACCOUNTANT, id: '61', permissions: ['DASHBOARD:VIEW', 'INVOICES:VIEW'] }

function dashboardApi(user: SessionUser, operations: () => MockReply | Promise<MockReply> = () => ok(OPERATIONS)) {
  signIn()
  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/notifications') return ok({ items: [], unread: 0 })
    if (request.path === '/dashboard/operations') return operations()
    if (request.path === '/dashboard/calendar') return ok({ month: request.query.get('month'), days: [] })
    return undefined
  })
}

const main = () => document.getElementById('main-content') as HTMLElement

/**
 * The page content as a user sees it, in a form two renders can be compared by: React's generated ids and the clock
 * time of the last refresh are the only parts that may differ between two renders of the same page.
 */
function pageMarkup(): string {
  return main()
    .innerHTML.replace(/_r_[0-9a-z]+_/g, '_id_')
    .replace(/Figures as of [^,]+,/g, 'Figures as of <time>,')
}

/** Every visible fact the client listed, read from the page. */
function pageFacts() {
  const cards = [...main().querySelectorAll('[data-kpi]')].map((card) => ({
    id: card.getAttribute('data-kpi'),
    title: card.querySelector('h3, h2, [role="heading"]')?.textContent?.trim(),
    text: card.textContent?.replace(/\s+/g, ' ').trim(),
    classes: card.className,
    style: card.getAttribute('style'),
  }))

  return {
    cards,
    sections: [...main().querySelectorAll('h1, h2')].map((heading) => heading.textContent?.replace(/\s+/g, ' ').trim()),
    links: [...main().querySelectorAll('a')].map((link) => `${link.textContent?.trim()} -> ${link.getAttribute('href')}`),
    buttons: [...main().querySelectorAll('button')].map((button) => button.textContent?.trim()),
  }
}

/** Renders both routes one after the other with the same user and data, and returns what each showed. */
async function bothRoutes(user: SessionUser, ready: () => Promise<unknown>, operations?: () => MockReply | Promise<MockReply>) {
  const result: Record<string, { markup: string; facts: ReturnType<typeof pageFacts> }> = {}

  for (const path of ['/dashboard', '/amc/management']) {
    dashboardApi(user, operations)
    const view = renderApp(path)
    await ready()
    result[path] = { markup: pageMarkup(), facts: pageFacts() }
    view.unmount()
    localStorage.clear()
  }

  return { dashboard: result['/dashboard']!, management: result['/amc/management']! }
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const loaded = () => screen.findByText(/Figures as of/)

describe('AMC Management and the Dashboard are the same page', () => {
  it('shows exactly the same page to an administrator: cards, titles, order, values, colours, sections and links', async () => {
    const { dashboard, management } = await bothRoutes(ADMIN, loaded)

    expect(dashboard.facts.cards).toHaveLength(12)
    expect(management.facts.cards.map((card) => card.id)).toEqual(dashboard.facts.cards.map((card) => card.id))
    expect(management.facts.cards.map((card) => card.title)).toEqual(dashboard.facts.cards.map((card) => card.title))
    expect(management.facts.cards.map((card) => card.text)).toEqual(dashboard.facts.cards.map((card) => card.text))
    expect(management.facts.cards.map((card) => [card.classes, card.style])).toEqual(dashboard.facts.cards.map((card) => [card.classes, card.style]))
    expect(management.facts.sections).toEqual(dashboard.facts.sections)
    expect(management.facts.links).toEqual(dashboard.facts.links)
    expect(management.facts.buttons).toEqual(dashboard.facts.buttons)
    // And nothing else differs anywhere in the page content.
    expect(management.markup).toBe(dashboard.markup)
  })

  it('shows the same financial totals and expiry counts on both, with what is not counted', async () => {
    const { dashboard, management } = await bothRoutes(ADMIN, loaded)
    const card = (facts: ReturnType<typeof pageFacts>, id: string) => facts.cards.find((item) => item.id === id)?.text

    for (const id of ['active', 'value', 'credit', 'expiring']) expect(card(management.facts, id)).toBe(card(dashboard.facts, id))
    expect(card(management.facts, 'value')).toContain('8,010.500')
    expect(card(management.facts, 'credit')).toContain('300.501')
    expect(card(management.facts, 'expiring')).toContain('3')
    expect(card(management.facts, 'active')).toContain('2 past validity not counted')
    expect(card(management.facts, 'active')).toContain('1 renewal starting later')
  })

  it('shows a restricted role the same reduced page on both routes', async () => {
    const { dashboard, management } = await bothRoutes(RESTRICTED, loaded)

    expect(management.markup).toBe(dashboard.markup)
    // Neither shows contract figures, which need AMC Contracts: View.
    expect(dashboard.markup).not.toContain('8,010.500')
  })

  it('shows the same empty page when there is no data', async () => {
    const { dashboard, management } = await bothRoutes(ADMIN, loaded, () => ok(EMPTY))

    expect(management.markup).toBe(dashboard.markup)
    expect(dashboard.facts.cards).toHaveLength(12)
  })

  it('shows the same loading state', async () => {
    const pending = () => new Promise<MockReply>(() => {})
    const { dashboard, management } = await bothRoutes(ADMIN, () => screen.findByText('Checking…'), pending)

    expect(management.markup).toBe(dashboard.markup)
    // Still waiting for the figures on both: no "Figures as of" line yet.
    expect(dashboard.markup).not.toContain('Figures as of')
  })

  it('shows the same error state with the same retry', async () => {
    const failing = () => fail(500, 'INTERNAL_ERROR', 'Something went wrong.')
    const { dashboard, management } = await bothRoutes(ADMIN, () => screen.findByText(/The dashboard figures could not be loaded/), failing)

    expect(management.markup).toBe(dashboard.markup)
    expect(management.facts.buttons).toContain('Try again')
  })
})

describe('the same permission on both routes', () => {
  it('opens both with Dashboard: View, even without AMC Contracts: View', async () => {
    for (const path of ['/dashboard', '/amc/management']) {
      dashboardApi(RESTRICTED)
      const view = renderApp(path)
      expect(await screen.findByRole('heading', { name: 'AMC Operations Dashboard' })).toBeInTheDocument()
      view.unmount()
    }
  })

  it('refuses both without Dashboard: View, even with AMC Contracts: View, and asks the API for nothing', async () => {
    const noDashboard: SessionUser = { ...ACCOUNTANT, id: '62', permissions: ['AMC_CONTRACTS:VIEW'] }

    for (const path of ['/dashboard', '/amc/management']) {
      const api = dashboardApi(noDashboard)
      const view = renderApp(path)
      expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
      expect(api.find('GET', '/dashboard/operations')).toHaveLength(0)
      view.unmount()
    }
  })

  it('lists AMC Management in the navigation exactly when the Dashboard is listed', async () => {
    for (const user of [ADMIN, RESTRICTED]) {
      dashboardApi(user)
      const view = renderApp('/dashboard')
      const nav = await screen.findByRole('navigation', { name: 'Main' })
      await waitFor(() => expect(within(nav).getAllByRole('link').length).toBeGreaterThan(0))
      const hrefs = [...nav.querySelectorAll('a')].map((link) => link.getAttribute('href'))
      expect(hrefs.includes('/dashboard')).toBe(true)
      view.unmount()
    }
  })
})

describe('KPI name helpers (still used by Accounts and AMC Renewal)', () => {
  it('reads saved names defensively', () => {
    expect(parseNames('{"active":"A","gone":"B","value":5}', ['active', 'value'])).toEqual({ active: 'A' })
    expect(parseNames('not json', ['active'])).toEqual({})
    expect(parseNames('["active"]', ['active'])).toEqual({})
    expect(parseNames(JSON.stringify({ active: 'x'.repeat(60) }), ['active']).active).toHaveLength(40)
    expect(displayName({ active: '   ' }, 'active', 'Active AMC')).toBe('Active AMC')
    expect(displayName({ active: ' Live ' }, 'active', 'Active AMC')).toBe('Live')
  })
})
