import { QueryClient } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { AppProviders, AppRoutes } from '../App'
import { ACTIONS, MODULES, type Client, type SessionUser } from '../lib/types'

export interface MockRequest {
  method: string
  /** Path after /api, without the query string. */
  path: string
  query: URLSearchParams
  body: unknown
  authorization: string | null
}

export interface MockReply {
  status: number
  body: unknown
}

export const ok = (data: unknown, status = 200): MockReply => ({ status, body: { success: true, data } })

export const fail = (status: number, code: string, message: string, details?: { field: string; message: string }[]): MockReply => ({
  status,
  body: { success: false, error: { code, message, ...(details ? { details } : {}) } },
})

/**
 * Replaces fetch with a stand-in for the API. The handler returns a reply, or
 * undefined for a route the test did not expect (reported as a 404).
 */
export function mockApi(handler: (request: MockRequest) => MockReply | Promise<MockReply> | undefined) {
  const requests: MockRequest[] = []

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost')
      const headers = (init?.headers ?? {}) as Record<string, string>
      const request: MockRequest = {
        method: init?.method ?? 'GET',
        path: url.pathname.replace(/^\/api/, ''),
        query: url.searchParams,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        authorization: headers.Authorization ?? null,
      }

      requests.push(request)

      const reply = (await handler(request)) ?? fail(404, 'NOT_FOUND', `Unexpected request: ${request.method} ${request.path}`)

      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
    }),
  )

  return {
    requests,
    find: (method: string, path: string) => requests.filter((request) => request.method === method && request.path === path),
  }
}

export const ADMIN: SessionUser = {
  id: '1',
  email: 'admin@example.com',
  fullName: 'Asha Admin',
  roles: [{ id: '1', code: 'ADMIN', name: 'Admin' }],
  permissions: MODULES.flatMap((module) => ACTIONS.map((action) => `${module}:${action}`)),
}

export const ACCOUNTANT: SessionUser = {
  id: '2',
  email: 'accountant@example.com',
  fullName: 'Arun Accountant',
  roles: [{ id: '2', code: 'ACCOUNTANT', name: 'Accountant' }],
  permissions: ['DASHBOARD:VIEW', 'CLIENTS:VIEW', 'PROJECTS:VIEW', 'EXPENSES:VIEW', 'EXPENSES:CREATE'],
}

export function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: '10',
    name: 'Test Client One',
    contactPerson: 'Front Desk',
    email: 'desk@example.com',
    phone: '111',
    address: null,
    notes: null,
    isActive: true,
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  }
}

/** Marks the browser as holding a session token. */
export function signIn() {
  localStorage.setItem('stslv-amc.token', 'test-token')
}

/** Renders the whole application at the given address. */
export function renderApp(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  )
}
