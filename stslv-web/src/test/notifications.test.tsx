import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { AlertList } from '../pages/notifications/notificationTypes'
import { ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// The notification bell and the Notifications page. Every figure is invented.

function list(read: string[] = []): AlertList {
  const items = [
    { key: 'visits.overdue', severity: 'warning' as const, title: 'Overdue maintenance visits', message: '3 visits are past the planned date and not completed.', link: '/amc/execution', count: 3 },
    { key: 'invoicing.amc_ready', severity: 'info' as const, title: 'AMC visits ready for invoice', message: '1 completed visit is waiting for an invoice (visit amounts 405.000).', link: '/invoices', count: 1 },
  ].map((item) => ({ ...item, isRead: read.includes(item.key), readAt: read.includes(item.key) ? '2026-10-26T08:00:00.000Z' : null }))

  return { items, unreadCount: items.filter((item) => !item.isRead).length }
}

function alertsApi(override?: (request: MockRequest) => MockReply | undefined) {
  signIn()
  let read: string[] = []

  return mockApi((request) => {
    const overridden = override?.(request)
    if (overridden) return overridden
    if (request.path === '/auth/me') return ok({ user: ADMIN })
    if (request.path === '/dashboard/summary') return ok({ clients: null, amc: null, projects: null, invoices: null })
    if (request.method === 'GET' && request.path === '/notifications') return ok(list(read))
    if (request.method === 'POST' && request.path === '/notifications/read-all') {
      read = ['visits.overdue', 'invoicing.amc_ready']
      return ok(list(read))
    }
    const match = /^\/notifications\/([a-z_.]+)\/read$/.exec(request.path)
    if (request.method === 'POST' && match) {
      read = [...read, match[1] as string]
      return ok(list(read))
    }

    return undefined
  })
}

describe('notification bell', () => {
  it('shows the unread count in the header and opens Notifications', async () => {
    alertsApi()
    renderApp('/dashboard')

    const bell = await screen.findByRole('link', { name: 'Notifications, 2 unread' })
    expect(bell).toHaveAttribute('href', '/notifications')
  })

  it('is hidden when alerts are unavailable', async () => {
    alertsApi((request) => (request.path === '/notifications' ? fail(503, 'FEATURE_UNAVAILABLE', 'Not applied.') : undefined))
    renderApp('/dashboard')

    await screen.findByRole('navigation', { name: 'Main' })
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Notifications/ })).not.toBeInTheDocument())
  })
})

describe('Notifications page', () => {
  it('lists the alerts with their message, kind and a link to the records', async () => {
    alertsApi()
    renderApp('/notifications')

    const items = within(await screen.findByRole('list', { name: 'Notifications' })).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Overdue maintenance visits')
    expect(items[0]).toHaveTextContent('Needs attention')
    expect(items[0]).toHaveTextContent('(unread)')
    expect(within(items[0] as HTMLElement).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/amc/execution')
    expect(items[1]).toHaveTextContent('For information')
  })

  it('marks one alert read, and then all', async () => {
    const api = alertsApi()
    renderApp('/notifications')

    await screen.findByRole('list', { name: 'Notifications' })
    await userEvent.click(screen.getByRole('button', { name: 'Mark "Overdue maintenance visits" as read' }))

    await waitFor(() => expect(api.find('POST', '/notifications/visits.overdue/read')).toHaveLength(1))
    expect(await screen.findByRole('link', { name: 'Notifications, 1 unread' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark "Overdue maintenance visits" as read' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(await screen.findByRole('link', { name: 'Notifications, none unread' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument()
  })

  it('says so when nothing needs attention', async () => {
    alertsApi((request) => (request.method === 'GET' && request.path === '/notifications' ? ok({ items: [], unreadCount: 0 }) : undefined))
    renderApp('/notifications')

    expect(await screen.findByText('Nothing needs attention')).toBeInTheDocument()
  })

  it('explains when the database update is missing', async () => {
    alertsApi((request) => (request.path === '/notifications' ? fail(503, 'FEATURE_UNAVAILABLE', 'Not applied.') : undefined))
    renderApp('/notifications')

    expect(await screen.findByText(/migration 0073/)).toBeInTheDocument()
  })
})
