import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { contractDocumentProblem, formatFileSize, readAsBase64 } from '../pages/amc/contractDocument'
import { ADMIN, fail, ok, renderApp } from './helpers'
import { amcApi, makeContract, typeReference } from './amc-helpers'

// Add AMC Contract, 2026-11-03: the contract document checks, and how the form treats contracts added before
// the System, Sales engineer, Final Credit and document became required.

describe('a server without file storage', () => {
  it('says so in the Add form and does not let a contract be added', async () => {
    amcApi(ADMIN, { override: (request) => (request.path === '/attachments/limits' ? ok({ maxMb: 12, allowedTypes: ['PDF'], storageAvailable: false }) : undefined) })
    renderApp('/amc/contracts')
    await userEvent.click(await screen.findByRole('button', { name: 'Add Contract' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add AMC Contract' })

    expect(await within(dialog).findByText(/this server has no file storage configured/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Add contract' })).toBeDisabled()
  })
})

describe('the Link master records panel', () => {
  it('offers no "Not linked" for a recorded link and sends only what changed', async () => {
    const api = amcApi(ADMIN, {
      contracts: [makeContract({ systemDescription: 'CCTV' })],
      override: (request) =>
        request.path === '/amc/contracts/100/masters' && request.method === 'GET'
          ? ok({ salesEngineer: { id: '5', name: 'Test Sales Engineer', employeeNo: null, isActive: true }, systemType: { id: '23', code: 'CCTV', name: 'CCTV', isActive: true } })
          : request.path === '/amc/contracts/100/masters' && request.method === 'PUT'
            ? ok({ salesEngineer: { id: '5', name: 'Test Sales Engineer', employeeNo: null, isActive: true }, systemType: { id: '22', code: 'AUTO', name: 'Automation', isActive: true } })
            : undefined,
    })
    renderApp('/amc/contracts/100')

    // The links are on the contract page's Details tab.
    await userEvent.click(await screen.findByRole('tab', { name: /Details/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Link master records' }))
    const dialog = await screen.findByRole('dialog', { name: 'Link master records' })
    const engineer = within(dialog).getByLabelText('Sales engineer')
    const type = within(dialog).getByLabelText('System type')
    await waitFor(() => expect(within(type).getAllByRole('option').length).toBeGreaterThan(1))
    expect(within(engineer).queryByRole('option', { name: 'Not linked' })).not.toBeInTheDocument()
    expect(within(type).queryByRole('option', { name: 'Not linked' })).not.toBeInTheDocument()

    await userEvent.selectOptions(type, '22')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save links' }))

    await waitFor(() => expect(api.find('PUT', '/amc/contracts/100/masters')).toHaveLength(1))
    expect(api.find('PUT', '/amc/contracts/100/masters')[0]?.body).toEqual({ systemTypeId: '22' })
  })
})

describe('contract document checks', () => {
  const file = (name: string, type: string, size = 100) => ({ name, type, size })

  it('accepts PDF and Word files, also when the browser reports no type', () => {
    expect(contractDocumentProblem(file('a.pdf', 'application/pdf'), 12)).toBeNull()
    expect(contractDocumentProblem(file('a.DOCX', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 12)).toBeNull()
    expect(contractDocumentProblem(file('a.doc', 'application/msword'), 12)).toBeNull()
    expect(contractDocumentProblem(file('a.docx', ''), 12)).toBeNull()
  })

  it('refuses other types, a type that disagrees with the name, empty and oversized files', () => {
    expect(contractDocumentProblem(file('a.png', 'image/png'), 12)).toBe('Choose a PDF or Word document (.pdf, .doc or .docx).')
    expect(contractDocumentProblem(file('a.pdf', 'image/png'), 12)).toBe('Choose a PDF or Word document (.pdf, .doc or .docx).')
    expect(contractDocumentProblem(file('noextension', 'application/pdf'), 12)).toBe('Choose a PDF or Word document (.pdf, .doc or .docx).')
    expect(contractDocumentProblem(file('a.pdf', 'application/pdf', 0), 12)).toBe('The chosen file is empty. Choose another file.')
    expect(contractDocumentProblem(file('a.pdf', 'application/pdf', 12 * 1024 * 1024), 12)).toBeNull()
    expect(contractDocumentProblem(file('a.pdf', 'application/pdf', 12 * 1024 * 1024 + 1), 12)).toBe('The file is 12.0 MB. Contract documents can be at most 12 MB.')
  })

  it('formats sizes and reads the content as base64', async () => {
    expect([formatFileSize(512), formatFileSize(2048), formatFileSize(5 * 1024 * 1024)]).toEqual(['512 B', '2.0 KB', '5.0 MB'])
    expect(await readAsBase64(new Blob(['%PDF-1.4']))).toBe('JVBERi0xLjQ=')
  })
})

/** An older contract: typed system with no System Types link, no sales engineer, no Final Credit, no document. */
const OLDER = makeContract({ systemDescription: 'Typed old system', finalCredit: null })

async function openEdit(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Edit ${name}` }))
  const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
  await waitFor(() => expect(within(dialog).getByLabelText(/^System/)).toBeEnabled())

  return dialog
}

describe('editing a contract added before the requirements', () => {
  it('keeps its typed system, empty Final Credit and missing engineer, and saves other changes', async () => {
    const api = amcApi(ADMIN, { contracts: [OLDER] })
    renderApp('/amc/contracts')
    const dialog = await openEdit('Test Hotel One Typed old system')

    const system = within(dialog).getByLabelText(/^System/)
    expect(system).toHaveDisplayValue('Typed old system (current, not in the list)')
    expect(within(dialog).getByText(/not linked to the System Types list/)).toBeInTheDocument()
    // Final Credit is not required on it, and "Not linked" stays possible for its engineer.
    expect(within(dialog).getByLabelText(/Final credit/)).not.toHaveAttribute('aria-required')
    expect(within(within(dialog).getByLabelText(/Sales engineer \(master list\)/)).getByRole('option', { name: 'Not linked' })).toBeInTheDocument()
    // No upload is asked for; the user is told where documents are kept.
    expect(dialog.querySelector('input[type="file"]')).toBeNull()
    expect(await within(dialog).findByText(/No document is on file for this contract\. Saving changes here does not require one/)).toBeInTheDocument()

    await userEvent.type(within(dialog).getByLabelText('Notes'), 'Edited')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(1))
    const body = api.find('PATCH', '/amc/contracts/100')[0]?.body as Record<string, unknown>
    expect(body).toMatchObject({ notes: 'Edited', finalCredit: '' })
    // Neither the system nor the engineer is sent: both stay as they are.
    expect(body).not.toHaveProperty('systemTypeId')
    expect(body).not.toHaveProperty('systemDescription')
    expect(body).not.toHaveProperty('salesEngineerId')
  })

  it('links it to a system type when one is chosen', async () => {
    const api = amcApi(ADMIN, { contracts: [OLDER] })
    renderApp('/amc/contracts')
    const dialog = await openEdit('Test Hotel One Typed old system')

    await userEvent.selectOptions(within(dialog).getByLabelText(/^System/), '23')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(1))
    expect(api.find('PATCH', '/amc/contracts/100')[0]?.body).toMatchObject({ systemTypeId: '23' })
  })
})

describe('renewing a contract added before the requirements', () => {
  it('keeps its typed system, as renewals always have, and sends no system type', async () => {
    const api = amcApi(ADMIN, {
      contracts: [OLDER],
      override: (request) =>
        request.path === '/amc/contracts/100/renewals' && request.method === 'GET'
          ? ok({ renewedFrom: null, renewals: [] })
          : request.path === '/amc/contracts/100/renewals' && request.method === 'POST'
            ? ok({ ...makeContract({ id: '150', status: 'DRAFT' }), scheduleChange: null }, 201)
            : undefined,
    })
    renderApp('/amc/contracts/100')

    await userEvent.click(await screen.findByRole('tab', { name: /Renewals/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Create renewal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Renew AMC Contract' })
    await waitFor(() => expect(within(dialog).getByLabelText(/^System/)).toHaveDisplayValue('Typed old system (as on the renewed contract)'))
    // No document is asked for on a renewal.
    expect(dialog.querySelector('input[type="file"]')).toBeNull()

    // A renewal has its own AMC Reference Number (0105).
    await typeReference(dialog, 'RENEW-OLD-001')
    await userEvent.selectOptions(await within(dialog).findByLabelText(/Sales engineer \(master list\)/), '5')
    await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2028-01-01')
    await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2028-12-31')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create renewal' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/100/renewals')).toHaveLength(1))
    const body = api.find('POST', '/amc/contracts/100/renewals')[0]?.body as Record<string, unknown>
    expect(body).toMatchObject({ amcReference: 'RENEW-OLD-001', systemDescription: 'Typed old system', salesEngineerId: '5' })
    expect(body).not.toHaveProperty('systemTypeId')
    expect(body).not.toHaveProperty('contractDocument')
  })
})

describe('editing a contract saved with the requirements', () => {
  it('shows its linked system, requires its Final Credit, and does not resend an unchanged system', async () => {
    const current = makeContract({ systemDescription: 'CCTV', finalCredit: '100.000' })
    const api = amcApi(ADMIN, {
      contracts: [current],
      override: (request) =>
        request.path === '/attachments' ? ok([{ id: '900', category: 'SIGNED_CONTRACT' }]) : request.path === '/amc/contracts/100/masters' ? ok({ salesEngineer: { id: '5', name: 'Test Sales Engineer', isActive: true }, systemType: { id: '23', code: 'CCTV', name: 'CCTV', isActive: true } }) : undefined,
    })
    renderApp('/amc/contracts')
    const dialog = await openEdit('Test Hotel One CCTV')

    expect(within(dialog).getByLabelText(/^System/)).toHaveValue('23')
    expect(await within(dialog).findByText(/1 document is on file/)).toBeInTheDocument()
    const engineer = await within(dialog).findByLabelText(/Sales engineer \(master list\)/)
    expect(engineer).toHaveValue('5')
    expect(within(engineer).queryByRole('option', { name: 'Not linked' })).not.toBeInTheDocument()

    await userEvent.clear(within(dialog).getByLabelText(/Final credit/))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    expect(await within(dialog).findByText('Final credit is required. Enter 0 when there is none.')).toBeInTheDocument()
    expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(0)

    await userEvent.type(within(dialog).getByLabelText(/Final credit/), '0')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(1))
    const body = api.find('PATCH', '/amc/contracts/100')[0]?.body as Record<string, unknown>
    expect(body).toMatchObject({ finalCredit: '0' })
    expect(body).not.toHaveProperty('systemTypeId')
  })

  it('keeps an existing contract editable while the System Types list cannot be loaded', async () => {
    amcApi(ADMIN, {
      contracts: [OLDER],
      override: (request) => (request.path === '/masters/system-types/options' ? fail(500, 'INTERNAL_ERROR', 'Something went wrong.') : undefined),
    })
    renderApp('/amc/contracts')
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One Typed old system' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })

    expect(await within(dialog).findByText(/The contract keeps its current system/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeEnabled()
  })
})
