import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../lib/types'
import { ADMIN, fail, mockApi, ok, renderApp, signIn } from './helpers'

const COUNTRIES = ['OMAN', 'QATAR', 'BAHRAIN', 'KSA', 'UAE', 'KUWAIT']

interface Holiday {
  id: string
  date: string
  name: string
  isReligious: boolean
  countries: string[]
  divisions: string | null
}

function holidaysApi(user: SessionUser = ADMIN) {
  const holidays: Holiday[] = [
    { id: 'a', date: '2026-11-18', name: 'National Day', isReligious: false, countries: ['OMAN'], divisions: null },
    { id: 'b', date: '2026-11-25', name: 'Eid Holiday', isReligious: true, countries: ['OMAN', 'UAE'], divisions: 'Execution' },
    { id: 'c', date: '2026-12-02', name: 'UAE National Day', isReligious: false, countries: ['UAE'], divisions: null },
  ]

  signIn()

  return mockApi((request) => {
    const { method, path } = request
    const body = (request.body ?? {}) as Record<string, unknown>

    if (path === '/auth/me') return ok({ user })
    if (method === 'GET' && path === '/holidays') return ok({ holidays, countries: COUNTRIES })
    if (method === 'POST' && path === '/holidays') {
      if (body.name === 'Duplicate') return fail(409, 'CONFLICT', 'This holiday is already on that date.')
      const created = { id: 'n', ...body } as Holiday
      holidays.push(created)
      return ok(created, 201)
    }
    const match = /^\/holidays\/(\w+)$/.exec(path)
    const index = holidays.findIndex((item) => item.id === match?.[1])

    if (match && method === 'PUT') {
      holidays[index] = { id: match[1] as string, ...body } as Holiday
      return ok(holidays[index])
    }
    if (match && method === 'DELETE') {
      holidays.splice(index, 1)
      return ok(null)
    }

    return undefined
  })
}

const open = async () => {
  // The list opens on the current year; pin it to 2026 so the data above is in view.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-10T09:00:00Z'))
  renderApp('/settings?section=holidays')
  const table = await screen.findByRole('table', { name: 'Holidays in 2026' })
  vi.useRealTimers()

  return table
}

describe('holiday calendar', () => {
  it('lists the whole year as a table, with no calendar grid, and includes the official Oman holidays', async () => {
    holidaysApi()
    const table = await open()
    const row = (name: string) => within(table).getByText(name).closest('tr') as HTMLElement

    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(within(table).getByText('January 2026')).toBeInTheDocument()
    expect(within(table).getByText('December 2026')).toBeInTheDocument()
    expect(within(table).getByText('Hijri New Year')).toBeInTheDocument()
    expect(within(row('National Day')).getByText('18 Nov 2026')).toBeInTheDocument()
    expect(within(row('National Day')).getByText('Wednesday')).toBeInTheDocument()
    expect(within(row('National Day')).getByText('All divisions')).toBeInTheDocument()
    expect(within(row('Eid Holiday')).getByText('Religious')).toBeInTheDocument()
    expect(within(row('Eid Holiday')).getByText('UAE')).toBeInTheDocument()
    expect(within(row('Eid Holiday')).getByText('Execution')).toBeInTheDocument()
    expect(within(row('Hijri New Year')).getByText('Official')).toBeInTheDocument()
    expect(within(row('Hijri New Year')).queryByRole('button')).not.toBeInTheDocument()
  })

  it('changes the list year by year', async () => {
    holidaysApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Next year' }))

    expect(await screen.findByRole('heading', { name: '2027' })).toBeInTheDocument()
    expect(await screen.findByText('No holidays in 2027')).toBeInTheDocument()
    expect(screen.getByText(/Oman has not announced its public holidays for 2027/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Previous year' }))
    await userEvent.click(screen.getByRole('button', { name: 'Previous year' }))

    expect(await screen.findByText('No holidays in 2025')).toBeInTheDocument()
  })

  it('adds a holiday for the chosen countries', async () => {
    const api = holidaysApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Add holiday' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add holiday' })
    await userEvent.type(within(dialog).getByLabelText(/Holiday name/), 'Prophet Birthday')
    await userEvent.click(within(dialog).getByLabelText('Religious holiday', { exact: false }))
    await userEvent.click(within(dialog).getByLabelText('Qatar'))
    await userEvent.click(within(dialog).getByLabelText('KSA'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add holiday' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Prophet Birthday was added.')
    expect(api.find('POST', '/holidays')[0]?.body).toMatchObject({ name: 'Prophet Birthday', isReligious: true, countries: ['QATAR', 'KSA'], divisions: null })
  })

  it('asks for a name and at least one country before sending', async () => {
    const api = holidaysApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Add holiday' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add holiday' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add holiday' }))

    expect(await within(dialog).findByText('Name is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Choose at least one country.')).toBeInTheDocument()
    expect(api.find('POST', '/holidays')).toHaveLength(0)
  })

  it('shows the server message for a duplicate', async () => {
    holidaysApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Add holiday' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add holiday' })
    await userEvent.type(within(dialog).getByLabelText(/Holiday name/), 'Duplicate')
    await userEvent.click(within(dialog).getByLabelText('Oman'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add holiday' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already on that date')
  })

  it('edits a holiday', async () => {
    const api = holidaysApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Edit National Day' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit holiday' })
    await userEvent.clear(within(dialog).getByLabelText(/Holiday name/))
    await userEvent.type(within(dialog).getByLabelText(/Holiday name/), 'Oman National Day')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Oman National Day was updated.')
    expect(api.find('PUT', '/holidays/a')[0]?.body).toMatchObject({ name: 'Oman National Day', date: '2026-11-18', countries: ['OMAN'] })
  })

  it('deletes a holiday after a confirmation', async () => {
    const api = holidaysApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Delete Eid Holiday' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete holiday' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete holiday' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Eid Holiday was deleted.')
    expect(api.find('DELETE', '/holidays/b')).toHaveLength(1)
  })

  it('adds the Oman holidays announced for the shown year, leaving out those already there', async () => {
    const api = holidaysApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Add Oman holidays' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add Oman holidays for 2026' })

    expect(within(dialog).getByText("Accession Day of His Majesty the Sultan")).toBeInTheDocument()
    expect(within(dialog).getByText('Hijri New Year')).toBeInTheDocument()
    expect(within(dialog).getByText('National Day (day 1 of 2)')).toBeInTheDocument()
    expect(within(dialog).queryByText('Renaissance Day')).not.toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: /^Add [0-9]+ holidays$/ }))

    expect(await screen.findByRole('status')).toHaveTextContent('Oman holidays were added for 2026.')
    const sent = api.find('POST', '/holidays').map((request) => request.body as { name: string; countries: string[] })

    expect(sent).toHaveLength(16)
    expect(sent.every((item) => item.countries.length === 1 && item.countries[0] === 'OMAN')).toBe(true)
    expect(sent.some((item) => item.name === 'Hijri New Year')).toBe(true)
  })

  it('says so when Oman has not announced the shown year yet', async () => {
    holidaysApi()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Next year' }))
    await screen.findByText('No holidays in 2027')

    expect(screen.queryByRole('button', { name: 'Add Oman holidays' })).not.toBeInTheDocument()
  })

  it('hides the buttons from people who may only view', async () => {
    holidaysApi({ ...ADMIN, permissions: ['DASHBOARD:VIEW', 'SETTINGS:VIEW'] })
    await open()

    expect(screen.queryByRole('button', { name: 'Add holiday' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument()
  })
})
