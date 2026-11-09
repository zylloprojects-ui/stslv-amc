import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { idleSeconds } from '../lib/api'
import { describeDevice } from '../lib/sessions'
import { ACCOUNTANT, fail, mockApi, ok, renderApp, signIn } from './helpers'

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const sessions = [
  { id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-11-09T08:00:00Z', lastActivityAt: '2026-11-09T09:00:00Z', expiresAt: '2026-11-09T16:00:00Z', idleExpiresAt: '2026-11-09T09:30:00Z', ipAddress: '203.0.113.5', userAgent: CHROME_WINDOWS, passwordChange: false, current: true },
  { id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-11-08T08:00:00Z', lastActivityAt: '2026-11-08T09:00:00Z', expiresAt: '2026-11-08T16:00:00Z', idleExpiresAt: '2026-11-08T09:30:00Z', ipAddress: '198.51.100.7', userAgent: SAFARI_IPHONE, passwordChange: false, current: false },
]

describe('active sessions (My Account)', () => {
  it('lists the sessions, signs out another device, and signs out of all devices after confirmation', async () => {
    signIn()
    const api = mockApi((request) => {
      if (request.path === '/auth/me') return ok({ user: ACCOUNTANT })
      if (request.method === 'GET' && request.path === '/auth/sessions') return ok(sessions)
      if (request.method === 'DELETE' && request.path === `/auth/sessions/${sessions[1]?.id}`) return ok(null)
      if (request.method === 'POST' && request.path === '/auth/logout-all') return ok({ sessionsEnded: 2 })
      if (request.method === 'POST' && request.path === '/auth/logout') return fail(401, 'SESSION_REVOKED', 'This session has been signed out.')
      return undefined
    })
    renderApp('/account')

    const list = await screen.findByRole('list', { name: 'Active sessions' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Chrome on Windows')
    expect(items[0]).toHaveTextContent('This device')
    // The current session has no per-device sign-out; the other one does.
    expect(within(items[0] as HTMLElement).queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()

    await userEvent.click(within(items[1] as HTMLElement).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(api.find('DELETE', `/auth/sessions/${sessions[1]?.id}`)).toHaveLength(1))

    await userEvent.click(screen.getByRole('button', { name: 'Sign out of all devices' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign out of all devices' })
    expect(api.find('POST', '/auth/logout-all')).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }))

    expect(await screen.findByRole('button', { name: 'Login' })).toBeInTheDocument()
    expect(api.find('POST', '/auth/logout-all')).toHaveLength(1)
    expect(localStorage.getItem('stslv-amc.token')).toBeNull()
  })

  it('explains an inactivity sign-out on the sign-in page', async () => {
    signIn()
    mockApi((request) => {
      if (request.path === '/auth/me') return fail(401, 'SESSION_IDLE_TIMEOUT', 'You were signed out after 30 minutes of inactivity. Please sign in again.')
      return undefined
    })
    renderApp('/dashboard')

    expect(await screen.findByText('You were signed out after 30 minutes of inactivity. Please sign in again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Login' })).toBeInTheDocument()
  })
})

describe('inactivity reporting', () => {
  it('sends the seconds since the last input with every signed-in request', async () => {
    signIn()
    mockApi((request) => (request.path === '/auth/me' ? ok({ user: ACCOUNTANT }) : request.path === '/auth/sessions' ? ok([]) : undefined))
    renderApp('/account')

    await screen.findByRole('heading', { name: 'My Account' })
    const calls = vi.mocked(fetch).mock.calls
    const headers = (calls.at(-1)?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers['X-Idle-Seconds']).toMatch(/^\d+$/)
  })

  it('counts the newest activity of any tab', () => {
    const now = Date.now()
    localStorage.setItem('stslv-amc.lastActivity', String(now - 5_000))
    expect(idleSeconds(now)).toBeLessThanOrEqual(5)
    expect(idleSeconds(now + 120_000)).toBeGreaterThanOrEqual(120)
  })

  it('names devices from the browser description', () => {
    expect(describeDevice(CHROME_WINDOWS)).toBe('Chrome on Windows')
    expect(describeDevice(SAFARI_IPHONE)).toBe('Safari on iOS')
    expect(describeDevice(null)).toBe('Unknown device')
  })
})
