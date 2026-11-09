import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { NAVIGATION } from '../layout/navigation'
import { helpTopicVisible, matchScore, pageLink, searchTopics, topicForPath, type HelpViewer } from '../help/helpModel'
import { HELP_TOPICS } from '../help/helpTopics'
import type { Module, SessionUser } from '../lib/types'
import { ADMIN, makeClient, mockApi, ok, renderApp, signIn } from './helpers'

// The user guide and the route table, read as text (the same way auth-recovery.test.tsx reads sources).
const GUIDE = Object.values(import.meta.glob('../../../docs/user-guide/USER_GUIDE.md', { query: '?raw', import: 'default', eager: true }))[0] as string
const APP_SOURCE = Object.values(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }))[0] as string
const NAV_PATHS = NAVIGATION.flatMap((section) => section.items.map((item) => item.path))

/** Route patterns the application defines (App.tsx), for checking the pages help points at. */
const ROUTES = [...APP_SOURCE.matchAll(/path="([^"]+)"/g)].map((match) => match[1])

function viewer(permissions: string[], isAdmin = false): HelpViewer {
  const held = new Set(permissions)
  return {
    can: (module: Module, action: 'VIEW') => held.has(`${module}:${action}`),
    canRead: (module: Module) => held.has(`${module}:VIEW`) || held.has(`${module}:READ`),
    isAdmin,
  }
}

const FINANCE: SessionUser = {
  id: '5',
  email: 'finance@example.com',
  fullName: 'Fatma Finance',
  roles: [{ id: '5', code: 'FINANCE_EXECUTIVE', name: 'Finance Executive' }],
  permissions: ['DASHBOARD:VIEW', 'AMC_SCHEDULE:READ', 'INVOICES:VIEW', 'INVOICES:EDIT', 'ACCOUNTS:VIEW', 'ACCOUNTS:EXPORT', 'SUGGESTIONS:VIEW', 'SUGGESTIONS:CREATE'],
}

function session(user: SessionUser) {
  signIn()
  return mockApi((request) => {
    if (request.path === '/auth/me') return ok({ user })
    if (request.path === '/clients') return ok({ items: [makeClient()], total: 1, page: 1, pageSize: 25 })
    if (request.path === '/notifications') return ok({ items: [], unreadCount: 0 })
    return undefined
  })
}

describe('help content', () => {
  it('has unique ids, and every related topic exists', () => {
    const ids = HELP_TOPICS.map((topic) => topic.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const topic of HELP_TOPICS) {
      for (const related of topic.related ?? []) expect(ids, `${topic.id} → ${related}`).toContain(related)
    }
  })

  it('points only at pages the application has', () => {
    for (const topic of HELP_TOPICS) {
      for (const page of topic.pages) expect(ROUTES, `${topic.id}: ${page}`).toContain(page)
      if (topic.access.kind === 'nav') expect(NAV_PATHS, topic.id).toContain(topic.access.path)
    }
  })

  it('covers every page in the navigation', () => {
    const covered = new Set(HELP_TOPICS.flatMap((topic) => topic.pages))
    expect(NAV_PATHS.filter((path) => !covered.has(path))).toEqual([])
  })

  it('names a chapter of the user guide that exists', () => {
    const chapters = [...GUIDE.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim())
    for (const topic of HELP_TOPICS) expect(chapters, topic.id).toContain(topic.guideChapter)
  })

  it('states that Paid is a reference status, not verified payment', () => {
    const text = JSON.stringify(HELP_TOPICS.find((topic) => topic.id === 'paid-vs-zoho'))
    expect(text).toContain('does not verify that money was received')
    expect(text).toContain('does not make a service Paid')
  })
})

describe('help visibility and context', () => {
  it('shows a page topic exactly to the users the sidebar shows the page to', () => {
    const accounts = HELP_TOPICS.find((topic) => topic.id === 'accounts')!
    expect(helpTopicVisible(accounts, viewer(['ACCOUNTS:VIEW']))).toBe(true)
    expect(helpTopicVisible(accounts, viewer(['DASHBOARD:VIEW']))).toBe(false)

    const audit = HELP_TOPICS.find((topic) => topic.id === 'audit-log')!
    expect(helpTopicVisible(audit, viewer(['USERS:VIEW']))).toBe(false)
    expect(helpTopicVisible(audit, viewer(['USERS:VIEW'], true))).toBe(true)
  })

  it('always offers the general topics', () => {
    const visible = HELP_TOPICS.filter((topic) => helpTopicVisible(topic, viewer([])))
    expect(visible.map((topic) => topic.id)).toEqual(expect.arrayContaining(['getting-started', 'paid-vs-zoho']))
    expect(visible.map((topic) => topic.id)).not.toContain('amc-contracts')
    // The Master Data Center hub follows its route guard: any one master module.
    expect(visible.map((topic) => topic.id)).not.toContain('master-data-center')
    expect(HELP_TOPICS.filter((topic) => helpTopicVisible(topic, viewer(['DEPARTMENTS:VIEW']))).map((topic) => topic.id)).toContain('master-data-center')
  })

  it('picks the most specific topic for an address', () => {
    expect(topicForPath(HELP_TOPICS, '/amc/contracts')?.id).toBe('amc-contracts')
    expect(topicForPath(HELP_TOPICS, '/amc/contracts/42')?.id).toBe('contract-360')
    expect(topicForPath(HELP_TOPICS, '/master-data/sales-engineers/7')?.id).toBe('sales-engineers')
    expect(topicForPath(HELP_TOPICS, '/master-data')?.id).toBe('master-data-center')
    expect(topicForPath(HELP_TOPICS, '/nowhere')).toBeNull()
    expect(matchScore('/amc/contracts', '/amc/schedule')).toBe(-1)
  })

  it('searches titles first, then the text', () => {
    const results = searchTopics(HELP_TOPICS, 'regenerate')
    expect(results[0].id).toBe('regenerate')
    expect(results.map((topic) => topic.id)).toContain('contract-360')
    expect(searchTopics(HELP_TOPICS, 'zzzz-nothing')).toEqual([])
  })

  it('offers "Go to" only for a concrete page', () => {
    expect(pageLink(HELP_TOPICS.find((topic) => topic.id === 'contract-360')!)).toBeNull()
    expect(pageLink(HELP_TOPICS.find((topic) => topic.id === 'accounts')!)).toBe('/finance/accounts')
  })
})

describe('help in the application', () => {
  it('opens help for the current page from the header, and closes on Escape', async () => {
    session(FINANCE)
    renderApp('/finance/accounts')

    await userEvent.click(await screen.findByRole('button', { name: 'Help for this page' }))
    const dialog = await screen.findByRole('dialog', { name: 'Help' })

    expect(within(dialog).getByRole('heading', { name: 'Accounts (Invoice No. entry)' })).toBeInTheDocument()
    expect(within(dialog).getByText('This page: Accounts (Invoice No. entry)')).toBeInTheDocument()
    expect(within(dialog).getByRole('searchbox', { name: 'Search help' })).toHaveFocus()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Help' })).not.toBeInTheDocument())
  })

  it('lists only the topics of pages the user may open', async () => {
    session(FINANCE)
    renderApp('/finance/accounts')

    await userEvent.click(await screen.findByRole('button', { name: 'Help for this page' }))
    const dialog = await screen.findByRole('dialog', { name: 'Help' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'All topics' }))

    expect(within(dialog).getByRole('button', { name: 'Invoice Tracking (Zoho)' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'AMC Contracts' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Audit Log' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Regenerate a schedule' })).not.toBeInTheDocument()

    // Related topics the user cannot open are not offered either.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Paid status and Zoho invoices' }))
    expect(within(dialog).getByRole('button', { name: 'Accounts (Invoice No. entry)' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Service Status (completing a service)' })).not.toBeInTheDocument()
  })

  it('searches and opens a topic, then goes to its page', async () => {
    session(FINANCE)
    const app = renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: 'Help for this page' }))
    const dialog = await screen.findByRole('dialog', { name: 'Help' })
    await userEvent.type(within(dialog).getByRole('searchbox', { name: 'Search help' }), 'zoho allocations')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Invoice Tracking (Zoho)' }))

    await userEvent.click(within(dialog).getByRole('link', { name: 'Go to Invoice Tracking (Zoho)' }))
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/invoices'))
    expect(screen.queryByRole('dialog', { name: 'Help' })).not.toBeInTheDocument()
  })

  it('offers the full user guide from the account menu', async () => {
    session(FINANCE)
    const app = renderApp('/dashboard')

    await userEvent.click(await screen.findByRole('button', { name: /Account menu/ }))
    await userEvent.click(screen.getByRole('link', { name: 'Help & User Guide' }))

    await waitFor(() => expect(app.router.state.location.pathname).toBe('/help'))
    expect(within(await screen.findByRole('article')).getByRole('heading', { name: 'Getting started', level: 2 })).toBeInTheDocument()
    expect(document.title).toBe('Help & User Guide · STSLEV AMC')
  })

  it('opens a topic by address, and refuses one the role cannot read', async () => {
    session(FINANCE)
    const allowed = renderApp('/help/accounts')
    expect(await screen.findByRole('heading', { name: 'Accounts (Invoice No. entry)', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to Accounts (Invoice No. entry)' })).toHaveAttribute('href', '/finance/accounts')
    allowed.unmount()

    session(FINANCE)
    renderApp('/help/audit-log')
    expect(await screen.findByRole('heading', { name: 'Help topic not available' })).toBeInTheDocument()
  })

  it('every topic link on the Help page opens its topic (Super Admin)', async () => {
    session(ADMIN)
    renderApp('/help')

    const nav = await screen.findByRole('navigation', { name: 'Help topics' })
    const links = within(nav).getAllByRole('link')
    expect(links).toHaveLength(HELP_TOPICS.length)

    for (const topic of HELP_TOPICS) {
      const link = within(nav).getByRole('link', { name: topic.title })
      expect(link).toHaveAttribute('href', `/help/${topic.id}`)
    }

    await userEvent.click(within(nav).getByRole('link', { name: 'Recycle Bin' }))
    expect(await screen.findByRole('heading', { name: 'Recycle Bin', level: 2 })).toBeInTheDocument()
  })

  it('offers a topic drop-down for narrow screens', async () => {
    session(ADMIN)
    const app = renderApp('/help')

    const select = await screen.findByRole('combobox', { name: 'Topic' })
    await userEvent.selectOptions(select, 'service-status')
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/help/service-status'))
  })
})
