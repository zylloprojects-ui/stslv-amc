import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { todayIso } from '../lib/format'
import type { SessionUser } from '../lib/types'
import { ACCOUNTANT, ADMIN, fail, renderApp } from './helpers'
import { makeProcurement, makeProject, projectsApi } from './projectsApi'

const VIEWER: SessionUser = { ...ACCOUNTANT, permissions: [...ACCOUNTANT.permissions, 'PROCUREMENT:VIEW'] }

const JOB_ONE = makeProject()
const JOB_TWO = makeProject({ id: '101', jobNumber: 'GPSA0002', description: 'CCTV upgrade' })
const CANCELLED_JOB = makeProject({ id: '102', jobNumber: 'GPSA0003', description: 'Abandoned job', status: 'CANCELLED' })
const DETECTORS = makeProcurement()
const BATTERIES = makeProcurement({
  id: '201',
  projectId: '101',
  jobNumber: 'GPSA0002',
  projectDescription: 'CCTV upgrade',
  description: 'Batteries',
  supplierName: null,
  quotationReference: null,
  quotationAmount: null,
  status: 'ORDERED',
})

describe('procurement list', () => {
  it('lists the requests returned by the API with their project and status', async () => {
    projectsApi(ADMIN, { projects: [JOB_ONE, JOB_TWO], procurement: [DETECTORS, BATTERIES] })
    renderApp('/procurement')

    const table = await screen.findByRole('table', { name: 'Procurement requests' })
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(2)
    const first = within(rows[0] as HTMLElement)
    expect(first.getByRole('link', { name: 'GPSA0001' })).toHaveAttribute('href', '/projects/100')
    expect(first.getByText('Smoke detectors')).toBeInTheDocument()
    expect(first.getByText('Test Supplier')).toBeInTheDocument()
    expect(first.getByText('412.500')).toBeInTheDocument()
    expect(first.getByText('Requested')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('Ordered')).toBeInTheDocument()
  })

  it('shows an empty state when there are no requests', async () => {
    projectsApi(ADMIN, { projects: [JOB_ONE] })
    renderApp('/procurement')

    expect(await screen.findByText('No procurement requests yet')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('filters by project and status through the API', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE, JOB_TWO], procurement: [DETECTORS, BATTERIES] })
    renderApp('/procurement')
    await screen.findByRole('table', { name: 'Procurement requests' })

    await userEvent.selectOptions(await screen.findByLabelText('Project'), '101')

    await waitFor(() => expect(screen.queryByText('Smoke detectors')).not.toBeInTheDocument())
    expect(screen.getByText('Batteries')).toBeInTheDocument()
    expect(api.find('GET', '/procurement').at(-1)?.query.get('projectId')).toBe('101')

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'DELIVERED')

    expect(await screen.findByText('No procurement requests match your search')).toBeInTheDocument()
    expect(api.find('GET', '/procurement').at(-1)?.query.get('status')).toBe('DELIVERED')
  })

  it('opens already filtered to a project when linked from that project', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE, JOB_TWO], procurement: [DETECTORS, BATTERIES] })
    renderApp('/procurement?projectId=101')

    expect(await screen.findByText('Batteries')).toBeInTheDocument()
    expect(screen.queryByText('Smoke detectors')).not.toBeInTheDocument()
    expect(api.find('GET', '/procurement')[0]?.query.get('projectId')).toBe('101')
    await waitFor(() => expect(screen.getByLabelText('Project')).toHaveValue('101'))
  })

  it('shows the stored details of a request', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE], procurement: [makeProcurement({ notes: 'Urgent', poReference: 'PO-9' })] })
    renderApp('/procurement')

    await userEvent.click(await screen.findByRole('button', { name: 'View request Smoke detectors' }))

    const dialog = await screen.findByRole('dialog', { name: 'Procurement request' })
    expect(await within(dialog).findByText('Urgent')).toBeInTheDocument()
    expect(within(dialog).getByText('PO-9')).toBeInTheDocument()
    expect(within(dialog).getByText(/GPSA0001 — Test Client One/)).toBeInTheDocument()
    expect(api.find('GET', '/procurement/200')).toHaveLength(1)
  })
})

describe('create procurement request', () => {
  it('validates the form before calling the API', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE] })
    renderApp('/procurement')

    await userEvent.click(await screen.findByRole('button', { name: 'New Request' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Procurement Request' })

    await userEvent.type(await within(dialog).findByLabelText('Quotation amount'), '12.3456')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add request' }))

    expect(await within(dialog).findByText('Select a project.')).toBeInTheDocument()
    expect(within(dialog).getByText('Requirement is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Enter a number with at most 3 decimal places, for example 1250.500.')).toBeInTheDocument()
    expect(api.find('POST', '/procurement')).toHaveLength(0)
  })

  it('offers only projects that can take new records, and narrows the list as you type', async () => {
    projectsApi(ADMIN, { projects: [JOB_ONE, JOB_TWO, CANCELLED_JOB] })
    renderApp('/procurement')

    await userEvent.click(await screen.findByRole('button', { name: 'New Request' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Procurement Request' })
    const picker = await within(dialog).findByLabelText(/^Project \/ job/)
    const labels = () => within(picker).getAllByRole('option').map((option) => option.textContent)

    expect(labels()).toEqual([
      'Select a project…',
      'GPSA0001 — Test Client One — Fire alarm panel replacement',
      'GPSA0002 — Test Client One — CCTV upgrade',
    ])

    await userEvent.type(within(dialog).getByLabelText('Find a job'), 'cctv')

    expect(labels()).toEqual(['Select a project…', 'GPSA0002 — Test Client One — CCTV upgrade'])
  })

  it('saves a new request against the chosen project and shows it in the list', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE, JOB_TWO] })
    renderApp('/procurement')

    await userEvent.click(await screen.findByRole('button', { name: 'New Request' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Procurement Request' })

    await userEvent.selectOptions(await within(dialog).findByLabelText(/^Project \/ job/), '101')
    await userEvent.type(within(dialog).getByLabelText(/^Requirement/), 'Network switch')
    await userEvent.type(within(dialog).getByLabelText('Supplier'), 'Alpha Traders')
    await userEvent.type(within(dialog).getByLabelText('Quotation amount'), '1234.567')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add request' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/procurement')[0]?.body).toEqual({
      projectId: '101',
      reference: '',
      description: 'Network switch',
      requestDate: todayIso(),
      supplierName: 'Alpha Traders',
      quotationReference: '',
      quotationDate: '',
      quotationAmount: '1234.567',
      poReference: '',
      orderDate: '',
      expectedDeliveryDate: '',
      notes: '',
    })
    expect(screen.getByRole('status')).toHaveTextContent('Procurement request added to GPSA0002.')

    const table = await screen.findByRole('table', { name: 'Procurement requests' })
    expect(within(table).getByText('Network switch')).toBeInTheDocument()
    expect(within(table).getByText('1,234.567')).toBeInTheDocument()
  })

  it('shows a field error from the API on the field', async () => {
    projectsApi(ADMIN, { projects: [JOB_ONE] }, (request) =>
      request.method === 'POST' && request.path === '/procurement'
        ? fail(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [
            { field: 'projectId', message: 'Project GPSA0001 is cancelled. Nothing new can be recorded against it.' },
          ])
        : undefined,
    )
    renderApp('/procurement')

    await userEvent.click(await screen.findByRole('button', { name: 'New Request' }))
    const dialog = await screen.findByRole('dialog', { name: 'New Procurement Request' })
    await userEvent.selectOptions(await within(dialog).findByLabelText(/^Project \/ job/), '100')
    await userEvent.type(within(dialog).getByLabelText(/^Requirement/), 'Item')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add request' }))

    expect(await within(dialog).findByText(/Project GPSA0001 is cancelled/)).toBeInTheDocument()
  })
})

describe('edit procurement request', () => {
  it('opens with the stored values and saves the changes without moving the request', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE], procurement: [DETECTORS] })
    renderApp('/procurement')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit request Smoke detectors' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit Procurement Request' })
    const supplier = within(dialog).getByLabelText('Supplier')

    expect(supplier).toHaveValue('Test Supplier')
    expect(within(dialog).getByLabelText('Quotation amount')).toHaveValue('412.500')
    // The project is shown, not offered for change.
    expect(within(dialog).queryByLabelText(/^Project \/ job/)).not.toBeInTheDocument()
    expect(within(dialog).getByText(/GPSA0001 — Test Client One/)).toBeInTheDocument()

    await userEvent.clear(supplier)
    await userEvent.type(supplier, 'Beta Supplies')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const body = api.find('PATCH', '/procurement/200')[0]?.body as Record<string, unknown>
    expect(body).toMatchObject({ supplierName: 'Beta Supplies', quotationAmount: '412.500' })
    expect(body).not.toHaveProperty('projectId')
    expect(await screen.findByText('Beta Supplies')).toBeInTheDocument()
  })
})

describe('procurement status', () => {
  it('updates the status, asking for the delivered date when delivered', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE], procurement: [DETECTORS] })
    renderApp('/procurement')

    await userEvent.click(await screen.findByRole('button', { name: 'Update status of request Smoke detectors' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update procurement status' })

    expect(within(dialog).queryByLabelText(/^Delivered date/)).not.toBeInTheDocument()
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'DELIVERED')
    fireEvent.change(within(dialog).getByLabelText(/^Delivered date/), { target: { value: '2026-09-18' } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Update status' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/procurement/200/status')[0]?.body).toEqual({ status: 'DELIVERED', deliveredDate: '2026-09-18' })
    const table = await screen.findByRole('table', { name: 'Procurement requests' })
    expect(await within(table).findByText('Delivered')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Procurement request on GPSA0001 is now Delivered.')
  })

  it('sends no delivered date with any other status, and stops offering Edit once cancelled', async () => {
    const api = projectsApi(ADMIN, { projects: [JOB_ONE], procurement: [DETECTORS] })
    renderApp('/procurement')

    await userEvent.click(await screen.findByRole('button', { name: 'Update status of request Smoke detectors' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update procurement status' })
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'CANCELLED')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Update status' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/procurement/200/status')[0]?.body).toEqual({ status: 'CANCELLED' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit request Smoke detectors' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Update status of request Smoke detectors' })).toBeInTheDocument()
  })
})

describe('procurement permissions', () => {
  it('offers a view-only role no way to add, edit or change status', async () => {
    projectsApi(VIEWER, { projects: [JOB_ONE], procurement: [DETECTORS] })
    renderApp('/procurement')

    expect(await screen.findByRole('button', { name: 'View request Smoke detectors' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New Request' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Update status/ })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'View request Smoke detectors' }))
    const dialog = await screen.findByRole('dialog', { name: 'Procurement request' })
    await within(dialog).findByText('Test Supplier')
    expect(within(dialog).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('refuses the page to a role that may not view procurement, without requesting its data', async () => {
    const api = projectsApi(ACCOUNTANT, { projects: [JOB_ONE], procurement: [DETECTORS] })
    renderApp('/procurement')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/procurement')).toHaveLength(0)
  })

  it('shows the message from the API when an action is refused', async () => {
    projectsApi(ADMIN, { projects: [JOB_ONE], procurement: [DETECTORS] }, (request) =>
      request.path === '/procurement/200/status' ? fail(403, 'FORBIDDEN', 'You do not have permission to perform this action.') : undefined,
    )
    renderApp('/procurement')

    await userEvent.click(await screen.findByRole('button', { name: 'Update status of request Smoke detectors' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update procurement status' })
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'QUOTED')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Update status' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You do not have permission to perform this action.')
  })
})
