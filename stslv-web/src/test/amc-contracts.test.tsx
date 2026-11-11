import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ACCOUNTANT, ADMIN, fail, renderApp } from './helpers'
import { amcApi, contractPdf, makeContract, makeVisit, typeReference, VIEWER } from './amc-helpers'

const FIRE = makeContract()
const DRAFT = makeContract({
  id: '101',
  client: { id: '11', name: 'Test Hotel Two', isActive: true },
  systemDescription: 'CCTV',
  status: 'DRAFT',
  contractValue: '9000.000',
  finalCredit: '8000.000',
  schedule: { visitCount: 0, completedCount: 0, openCount: 0, historicalCount: 0, cancelledCount: 0, amountMissingCount: 0, scheduledTotal: '0.000', annualAmount: null, servicesPerCycle: null, perServiceAmount: null, expectedTermTotal: null, generatedTotal: '0.000', valueDifference: null },
})

/** Waits for a contract's own page and returns queries scoped to its main content. */
async function openedContract(title: string) {
  await screen.findByRole('heading', { name: title })

  return within(screen.getByRole('main'))
}

async function openAddForm() {
  await userEvent.click(await screen.findByRole('button', { name: 'Add Contract' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add AMC Contract' })
  await within(dialog).findByLabelText(/Client/)
  // The System and Sales engineer lists come from the master data.
  await waitFor(() => expect(within(dialog).getByLabelText(/^System/)).toBeEnabled())
  await within(dialog).findByLabelText(/Service engineer \(master list\)/)

  return dialog
}

/** The hidden file input behind the "Attach file" button. */
function documentInput(dialog: HTMLElement): HTMLInputElement {
  return dialog.querySelector('input[type="file"]') as HTMLInputElement
}

/**
 * Fills every field a new contract needs, with the system, sales engineer and contract document, and an AMC
 * Reference Number unless one was already typed.
 */
async function fillRequired(dialog: HTMLElement, system = '21') {
  const reference = within(dialog).queryByLabelText(/AMC Reference Number/) as HTMLInputElement | null
  if (reference && !reference.readOnly && reference.value === '') await typeReference(dialog)
  await userEvent.selectOptions(within(dialog).getByLabelText(/Client/), '10')
  await userEvent.selectOptions(within(dialog).getByLabelText(/^System/), system)
  await userEvent.selectOptions(within(dialog).getByLabelText(/Service engineer \(master list\)/), '5')
  await userEvent.selectOptions(within(dialog).getByLabelText(/Maintenance frequency/), 'MONTHLY')
  await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2027-01-01')
  await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2027-12-31')
  await userEvent.type(within(dialog).getByLabelText(/AMC Value \/ Year/), '100')
  await userEvent.type(within(dialog).getByLabelText(/Final credit/), '0')
  await userEvent.upload(documentInput(dialog), contractPdf())
}

describe('contract list', () => {
  it('lists the contracts returned by the API with client, validity, value, progress and status', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE, DRAFT] })
    renderApp('/amc/contracts')

    const table = await screen.findByRole('table', { name: 'AMC contracts' })
    const rows = within(table).getAllByRole('row').slice(1)

    expect(rows).toHaveLength(2)
    const first = within(rows[0] as HTMLElement)
    expect(first.getByText('Test Hotel One')).toBeInTheDocument()
    expect(first.getByText('FIRE')).toBeInTheDocument()
    expect(first.getByText('01 Jan 2027 – 31 Dec 2027')).toBeInTheDocument()
    expect(first.getByText('Quarterly')).toBeInTheDocument()
    expect(first.getByText('1,620.000')).toBeInTheDocument()
    expect(first.getByText('1 of 4 completed')).toBeInTheDocument()
    expect(first.getByText('Active')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('9,000.000')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('Draft')).toBeInTheDocument()
    // It is no longer a placeholder, and the data came from the API.
    expect(screen.queryByText('Module implementation in progress')).not.toBeInTheDocument()
    expect(api.find('GET', '/amc/contracts')).toHaveLength(1)
  })

  it('shows an empty state when there are no contracts', async () => {
    amcApi(ADMIN)
    renderApp('/amc/contracts')

    expect(await screen.findByText('No AMC contracts yet')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('searches and filters through the API', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE, DRAFT] })
    renderApp('/amc/contracts')
    await screen.findByRole('table', { name: 'AMC contracts' })

    await userEvent.selectOptions(screen.getByLabelText('Contract status'), 'DRAFT')
    await waitFor(() => expect(screen.queryByText('Test Hotel One', { selector: 'td' })).not.toBeInTheDocument())
    expect(api.find('GET', '/amc/contracts').at(-1)?.query.get('status')).toBe('DRAFT')

    await userEvent.selectOptions(screen.getByLabelText('Client'), '11')
    await userEvent.selectOptions(screen.getByLabelText('Frequency'), 'QUARTERLY')
    await userEvent.type(screen.getByLabelText('Search'), 'cctv')

    await waitFor(() => expect(api.find('GET', '/amc/contracts').at(-1)?.query.get('search')).toBe('cctv'))
    const last = api.find('GET', '/amc/contracts').at(-1)?.query
    expect(last?.get('clientId')).toBe('11')
    expect(last?.get('frequency')).toBe('QUARTERLY')
  })

  it('offers an "All" first option on every dropdown, filled from the filter options', async () => {
    amcApi(ADMIN, { contracts: [FIRE, DRAFT] })
    renderApp('/amc/contracts')
    await screen.findByRole('table', { name: 'AMC contracts' })

    const expected: [string, string, string[]][] = [
      ['Client', 'All clients', ['Test Hotel One', 'Test Hotel Two']],
      ['System', 'All systems', ['FIRE', 'CCTV']],
      ['Year', 'All years', ['2027']],
      ['Service engineer', 'All service engineers', ['Test Sales Engineer']],
      ['Frequency', 'All frequencies', ['Quarterly']],
      ['Contract status', 'All contract statuses', ['Draft', 'Active', 'Expired', 'Cancelled']],
    ]

    for (const [label, all, values] of expected) {
      const select = (await screen.findByLabelText(label)) as HTMLSelectElement
      await waitFor(() => expect(select.options.length).toBeGreaterThan(1))
      const options = [...select.options].map((option) => option.text)

      expect(options[0], label).toBe(all)
      expect(select.value, label).toBe(label === 'Contract status' ? 'all' : '')
      expect(options.slice(1).sort(), label).toEqual([...values].sort())
    }
  })

  it('combines system, year and sales engineer filters, and "All" removes each one', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE, DRAFT] })
    renderApp('/amc/contracts')
    await screen.findByRole('table', { name: 'AMC contracts' })
    const lastQuery = () => api.find('GET', '/amc/contracts').at(-1)?.query

    await userEvent.selectOptions(await screen.findByLabelText('Year'), '2027')
    await waitFor(() => expect(lastQuery()?.get('year')).toBe('2027'))
    expect(lastQuery()?.get('system')).toBeNull()

    await userEvent.selectOptions(screen.getByLabelText('System'), 'CCTV')
    await userEvent.selectOptions(screen.getByLabelText('Service engineer'), '5')
    await waitFor(() => expect(lastQuery()?.get('salesEngineerId')).toBe('5'))
    expect(lastQuery()?.get('year')).toBe('2027')
    expect(lastQuery()?.get('system')).toBe('CCTV')
    expect(lastQuery()?.get('page')).toBe('1')

    await userEvent.selectOptions(screen.getByLabelText('Year'), '')
    await waitFor(() => expect(lastQuery()?.get('year')).toBeNull())
    expect(lastQuery()?.get('system')).toBe('CCTV')
    expect(lastQuery()?.get('salesEngineerId')).toBe('5')
  })

  it('resets every filter to "All" and clears the search', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE, DRAFT] })
    renderApp('/amc/contracts')
    await screen.findByRole('table', { name: 'AMC contracts' })
    const reset = screen.getByRole('button', { name: 'Reset filters' })
    expect(reset).toBeDisabled()

    await userEvent.selectOptions(await screen.findByLabelText('Client'), '11')
    await userEvent.selectOptions(screen.getByLabelText('System'), 'CCTV')
    await userEvent.selectOptions(screen.getByLabelText('Year'), '2027')
    await userEvent.selectOptions(screen.getByLabelText('Service engineer'), '5')
    await userEvent.selectOptions(screen.getByLabelText('Frequency'), 'QUARTERLY')
    await userEvent.selectOptions(screen.getByLabelText('Contract status'), 'ACTIVE')
    await userEvent.type(screen.getByLabelText('Search'), 'nothing matches')
    expect(await screen.findByText('No contracts match your filters')).toBeInTheDocument()

    await userEvent.click(reset)

    for (const label of ['Client', 'System', 'Year', 'Service engineer', 'Frequency']) {
      expect((screen.getByLabelText(label) as HTMLSelectElement).value, label).toBe('')
    }
    expect((screen.getByLabelText('Contract status') as HTMLSelectElement).value).toBe('all')
    expect(screen.getByLabelText('Search')).toHaveValue('')
    expect(await screen.findByRole('table', { name: 'AMC contracts' })).toBeInTheDocument()
    const last = api.find('GET', '/amc/contracts').at(-1)?.query
    for (const key of ['clientId', 'system', 'year', 'salesEngineerId', 'frequency', 'search']) {
      expect(last?.get(key), key).toBeNull()
    }
    expect(last?.get('status')).toBe('all')
    expect(reset).toBeDisabled()
  })

  it('shows an error with a retry when the list cannot be loaded', async () => {
    let failing = true
    amcApi(ADMIN, {
      contracts: [FIRE],
      override: (request) => (failing && request.path === '/amc/contracts' ? fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.') : undefined),
    })
    renderApp('/amc/contracts')

    expect(await screen.findByRole('alert')).toHaveTextContent('An unexpected error occurred.')

    failing = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('table', { name: 'AMC contracts' })).toBeInTheDocument()
  })
})

describe('add contract', () => {
  it('validates the form before calling the API', async () => {
    const api = amcApi(ADMIN)
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await userEvent.type(within(dialog).getByLabelText(/AMC Value \/ Year/), '1620.1234')
    await userEvent.type(within(dialog).getByLabelText(/Final credit/), '-5')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    expect(await within(dialog).findByText('Select a client.')).toBeInTheDocument()
    expect(within(dialog).getByText('AMC Reference Number is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Select a system.')).toBeInTheDocument()
    expect(within(dialog).getByText('Select a service engineer.')).toBeInTheDocument()
    expect(within(dialog).getByText('Attach the contract document.')).toBeInTheDocument()
    expect(within(dialog).getByText('Valid from is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Select a maintenance frequency.')).toBeInTheDocument()
    expect(within(dialog).getAllByText('Enter an amount of zero or more with at most 3 decimal places.')).toHaveLength(2)
    expect(api.find('POST', '/amc/contracts')).toHaveLength(0)
  })

  it('rejects a validity that ends before it starts', async () => {
    const api = amcApi(ADMIN)
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2027-06-01')
    await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2027-05-31')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    expect(await within(dialog).findByText('Valid to must be on or after Valid from.')).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts')).toHaveLength(0)
  })

  it('offers Active as the only status, selected by default (Draft removed 2026-11-04)', async () => {
    amcApi(ADMIN)
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    const status = within(dialog).getByLabelText(/^Status/) as HTMLSelectElement
    expect([...status.options].map((option) => option.textContent)).toEqual(['Active'])
    expect(status.value).toBe('ACTIVE')
    expect(within(dialog).queryByRole('option', { name: 'Draft' })).not.toBeInTheDocument()
    expect(within(dialog).getByText('The maintenance schedule is generated as soon as the contract is added.')).toBeInTheDocument()
  })

  it('saves a new contract for a client from the Client Master, with money sent as text', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    // Typed by hand, kept as typed apart from the outer spaces.
    await typeReference(dialog, '  STSLV-AMC-2026-015 ')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Client/), '11')
    await userEvent.selectOptions(within(dialog).getByLabelText(/^System/), '22')
    await userEvent.type(within(dialog).getByLabelText('Responsible engineer'), 'Second Engineer')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Service engineer \(master list\)/), '5')
    await userEvent.selectOptions(within(dialog).getByLabelText(/Maintenance frequency/), 'HALF_YEARLY')
    await userEvent.type(within(dialog).getByLabelText(/Valid from/), '2027-03-01')
    await userEvent.type(within(dialog).getByLabelText(/Valid to/), '2028-02-29')
    await userEvent.type(within(dialog).getByLabelText(/AMC Value \/ Year/), '9000')
    await userEvent.type(within(dialog).getByLabelText('Default visit amount'), '4500.000')
    // Final credit was filled from AMC Value (2026-11-11); a different amount typed over it is kept.
    await userEvent.clear(within(dialog).getByLabelText(/Final credit/))
    await userEvent.type(within(dialog).getByLabelText(/Final credit/), '8000.5')
    await userEvent.upload(documentInput(dialog), new File(['%PDF-1.4'], 'signed.pdf', { type: 'application/pdf' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('POST', '/amc/contracts')[0]?.body).toEqual({
      amcReference: 'STSLV-AMC-2026-015',
      clientId: '11',
      // A new contract starts on AMC Value / Year (2026-11-11).
      billingBasis: 'CONTRACT_VALUE',
      systemTypeId: '22',
      systemDescription: 'Automation',
      salesEngineerId: '5',
      responsibleEngineer: 'Second Engineer',
      validFrom: '2027-03-01',
      validTo: '2028-02-29',
      maintenanceFrequency: 'HALF_YEARLY',
      contractValue: '9000',
      defaultVisitAmount: '4500.000',
      finalCredit: '8000.5',
      description: '',
      notes: '',
      status: 'ACTIVE',
      // The file travels with the contract, as base64 ("%PDF-1.4").
      contractDocument: { fileName: 'signed.pdf', contentBase64: 'JVBERi0xLjQ=' },
    })
    expect(screen.getByRole('status')).toHaveTextContent('The contract for Test Hotel Two Automation was added. 4 visit(s) added to the schedule.')
    // The list is read again from the API.
    expect(await screen.findByRole('link', { name: 'View Test Hotel Two Automation' })).toBeInTheDocument()
  })

  it('offers only clients from the Client Master, and systems only from the System Types master', async () => {
    amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    const options = within(within(dialog).getByLabelText(/Client/)).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['Select a client…', 'Test Hotel One', 'Test Hotel Two'])
    // A dropdown, not free text: no text box and no list of suggestions.
    const system = within(dialog).getByLabelText(/^System/)
    expect(system.tagName).toBe('SELECT')
    expect(system).toHaveAttribute('aria-required', 'true')
    expect(dialog.querySelector('datalist')).toBeNull()
    expect(within(system).getAllByRole('option').map((option) => option.textContent)).toEqual(['Select a system...', 'FIRE', 'Automation (AUTO)', 'CCTV'])
    // The AMC Reference Number comes first, is required, and starts empty: nothing is generated or prefilled.
    const reference = within(dialog).getByLabelText(/AMC Reference Number/)
    expect(reference).toHaveValue('')
    expect(reference).toHaveAttribute('aria-required', 'true')
    expect(within(dialog).getAllByRole('textbox')[0]).toBe(reference)
    // There is no client code to fill in.
    expect(within(dialog).queryByLabelText(/client code/i)).not.toBeInTheDocument()
  })

  it.each([
    ['  ', 'AMC Reference Number is required.'],
    ['AMC#001', 'AMC Reference Number may use letters, digits, spaces and - _ . / & only, and must start with a letter or digit.'],
  ])('refuses the AMC Reference Number %j before calling the API', async (value, message) => {
    const api = amcApi(ADMIN)
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await typeReference(dialog, value)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    expect(await within(dialog).findByText(message)).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts')).toHaveLength(0)
  })

  it('shows a duplicate AMC Reference Number on its field and keeps what was typed', async () => {
    const DUPLICATE = 'AMC Reference Number already exists. Please enter a different number.'
    amcApi(ADMIN, {
      override: (request) =>
        request.method === 'POST' && request.path === '/amc/contracts' ? fail(409, 'CONFLICT', DUPLICATE, [{ field: 'amcReference', message: DUPLICATE }]) : undefined,
    })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await typeReference(dialog, 'AMC-0100')
    await fillRequired(dialog)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    expect(await within(dialog).findByText(DUPLICATE)).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/AMC Reference Number/)).toHaveValue('AMC-0100')
    expect(within(dialog).getByLabelText(/AMC Reference Number/)).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows a field error returned by the API on that field', async () => {
    amcApi(ADMIN, {
      override: (request) =>
        request.method === 'POST' && request.path === '/amc/contracts'
          ? fail(400, 'VALIDATION_ERROR', 'The selected client is inactive.', [
              { field: 'clientId', message: 'An inactive client cannot be selected. Reactivate the client first.' },
            ])
          : undefined,
    })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await fillRequired(dialog)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    expect(await within(dialog).findByText('An inactive client cannot be selected. Reactivate the client first.')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Add AMC Contract' })).toBeInTheDocument()
  })

  it('requires an active sales engineer and offers no "Not linked"', async () => {
    amcApi(ADMIN)
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    const engineer = within(dialog).getByLabelText(/Service engineer \(master list\)/)
    expect(engineer).toHaveAttribute('aria-required', 'true')
    expect(within(engineer).queryByRole('option', { name: 'Not linked' })).not.toBeInTheDocument()
    expect(within(engineer).getByRole('option', { name: 'Select a service engineer…' })).toBeDisabled()

    await fillRequired(dialog)
    expect(within(engineer).getAllByRole('option').map((option) => option.textContent)).toEqual(['Select a service engineer…', 'Test Sales Engineer'])
  })

  it('requires Final Credit and accepts zero', async () => {
    const api = amcApi(ADMIN)
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await fillRequired(dialog)
    await userEvent.clear(within(dialog).getByLabelText(/Final credit/))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    expect(await within(dialog).findByText('Final credit is required.')).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts')).toHaveLength(0)

    await userEvent.type(within(dialog).getByLabelText(/Final credit/), '0.000')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts')[0]?.body).toMatchObject({ finalCredit: '0.000', systemTypeId: '21', systemDescription: 'FIRE', salesEngineerId: '5' })
  })

  it('shows the chosen document with its size, and lets it be removed or replaced', async () => {
    amcApi(ADMIN)
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    expect(within(dialog).getByText('No file chosen')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /Contract document.*Attach file/ })).toBeInTheDocument()

    await userEvent.upload(documentInput(dialog), contractPdf('first.pdf', 2048))
    expect(within(dialog).getByText('first.pdf')).toBeInTheDocument()
    expect(within(dialog).getByText('2.0 KB')).toBeInTheDocument()

    await userEvent.upload(documentInput(dialog), new File([new Uint8Array(10)], 'second.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
    expect(within(dialog).queryByText('first.pdf')).not.toBeInTheDocument()
    expect(within(dialog).getByText('second.docx')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove second.docx' }))
    expect(within(dialog).getByText('No file chosen')).toBeInTheDocument()
  })

  it('refuses a document of another type, or one that is too large, before anything is sent', async () => {
    const api = amcApi(ADMIN)
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    // The picker offers only PDF and Word files; one chosen anyway is refused.
    await userEvent.upload(documentInput(dialog), new File(['x'], 'photo.png', { type: 'image/png' }), { applyAccept: false })
    expect(within(dialog).getByText('Choose a PDF or Word document (.pdf, .doc or .docx).')).toBeInTheDocument()

    await userEvent.upload(documentInput(dialog), contractPdf('huge.pdf', 12 * 1024 * 1024 + 1))
    expect(within(dialog).getByText('The file is 12.0 MB. Contract documents can be at most 12 MB.')).toBeInTheDocument()
    expect(within(dialog).getByText('No file chosen')).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts')).toHaveLength(0)
  })

  it('shows a server refusal of the document on the document field, and creates nothing', async () => {
    const api = amcApi(ADMIN, {
      override: (request) =>
        request.method === 'POST' && request.path === '/amc/contracts'
          ? fail(400, 'VALIDATION_ERROR', 'Word documents with macros cannot be uploaded.', [{ field: 'contractDocument', message: 'Word documents with macros cannot be uploaded.' }])
          : undefined,
    })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    await fillRequired(dialog)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add contract' }))

    expect(await within(dialog).findByText('Word documents with macros cannot be uploaded.')).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Add AMC Contract' })).toBeInTheDocument()
  })

  it('cannot add a contract while the System Types list cannot be loaded', async () => {
    amcApi(ADMIN, { override: (request) => (request.path === '/masters/system-types/options' ? fail(500, 'INTERNAL_ERROR', 'Something went wrong.') : undefined) })
    renderApp('/amc/contracts')
    await userEvent.click(await screen.findByRole('button', { name: 'Add Contract' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add AMC Contract' })

    expect(await within(dialog).findByText('The System Types list could not be loaded, and a contract needs a system. Close this form and try again.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Add contract' })).toBeDisabled()
  })

  it('says so when there are no active system types', async () => {
    amcApi(ADMIN, { override: (request) => (request.path === '/masters/system-types/options' ? { status: 200, body: { success: true, data: [] } } : undefined) })
    renderApp('/amc/contracts')
    const dialog = await openAddForm()

    expect(within(dialog).getByText('No active system types. Add one in Master Data → System Types first.')).toBeInTheDocument()
    expect(within(within(dialog).getByLabelText(/^System/)).getAllByRole('option')).toHaveLength(1)
  })
})

describe('contract figures', () => {
  it('shows exactly four figures, in order, over every contract outside the Recycle Bin', async () => {
    amcApi(ADMIN, {
      contracts: [
        FIRE,
        DRAFT,
        makeContract({ id: '102', status: 'CANCELLED', contractValue: '100.500', finalCredit: '50.250' }),
        makeContract({ id: '103', status: 'EXPIRED', contractValue: '0.000', finalCredit: null }),
        makeContract({ id: '104', status: 'ACTIVE', isPastValidity: true, contractValue: '1000.000', finalCredit: '0.000' }),
      ],
    })
    renderApp('/amc/contracts')

    const strip = await screen.findByRole('group', { name: 'AMC contract figures' })
    const labels = within(strip).getAllByText(/^(All AMC Contracts|Total AMC Value|Total Final Credit|Expired)$/)
    expect(labels.map((label) => label.textContent)).toEqual(['All AMC Contracts', 'Total AMC Value', 'Total Final Credit', 'Expired'])
    // The count rises to its value over 800 ms when the strip appears; allow for a busy test run.
    await waitFor(() => expect(within(strip).getByText('Expired').parentElement).toHaveTextContent('Expired2'), { timeout: 5000 })
    // Draft and cancelled contracts count; an Active contract past its end date counts as expired, once.
    await waitFor(() => expect(within(strip).getByText('Total AMC Value').parentElement).toHaveTextContent('Total AMC Value11,720.500OMR'))
    expect(within(strip).getByText('Total Final Credit').parentElement).toHaveTextContent('Total Final Credit8,050.250OMR')
    expect(within(strip).getByText('2 contracts have no Final Credit recorded.', { exact: false })).toBeInTheDocument()
    // The strip no longer has Active, Draft or Cancelled figures, and its tiles are figures, not filters.
    expect(within(strip).queryByText('Active')).not.toBeInTheDocument()
    expect(within(strip).queryByText('Draft')).not.toBeInTheDocument()
    expect(within(strip).queryByText('Cancelled')).not.toBeInTheDocument()
    expect(within(strip).queryAllByRole('button')).toHaveLength(0)
  })
})

describe('contract details', () => {
  it('opens the contract page from the list, with the stored contract, its figures and its dated visits', async () => {
    const api = amcApi(ADMIN, {
      contracts: [makeContract({ finalCredit: '1500.000', schedule: { ...FIRE.schedule, scheduledTotal: '1215.000', valueDifference: '405.000' } })],
      visits: [
        makeVisit({ status: 'COMPLETED', completedDate: '2027-01-04', invoiceEligibility: 'READY_FOR_INVOICE' }),
        makeVisit({ id: '501', sequenceNo: 2, periodStart: '2027-04-01', periodEnd: '2027-06-30', scheduledDate: '2027-04-01', visitAmount: '0.000' }),
      ],
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('link', { name: 'View Test Hotel One FIRE' }))
    const page = await openedContract('Test Hotel One — FIRE')

    expect(page.getByText('01 Jan 2027 – 31 Dec 2027')).toBeInTheDocument()
    const commercial = within(page.getByRole('region', { name: 'Contract figures' }))
    expect(commercial.getByText('1,620.000')).toBeInTheDocument()
    expect(commercial.getByText('1,500.000')).toBeInTheDocument()
    expect(commercial.getByText('1,215.000')).toBeInTheDocument()
    expect(page.getByText(/differ from the/)).toBeInTheDocument()

    const table = await page.findByRole('table', { name: 'Visits of this contract' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('Completed')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByText('Ready for invoice')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('0.000')).toBeInTheDocument()
    expect(api.find('GET', '/amc/contracts/100')).toHaveLength(1)
    expect(api.find('GET', '/amc/visits')[0]?.query.get('contractId')).toBe('100')
  })
})

describe('edit contract', () => {
  it('opens with the current values and saves changes that do not affect the schedule directly', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const value = await within(dialog).findByLabelText(/AMC Value \/ Year/)

    expect(value).toHaveValue('1620.000')
    expect(within(dialog).getByLabelText(/Client/)).toHaveValue('10')
    expect(within(dialog).getByLabelText(/Valid from/)).toHaveValue('2027-01-01')
    // The status is changed from the details view, not here.
    expect(within(dialog).queryByLabelText(/Status/)).not.toBeInTheDocument()

    await userEvent.clear(value)
    await userEvent.type(value, '1800')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PATCH', '/amc/contracts/100')[0]?.body).toMatchObject({ contractValue: '1800', validFrom: '2027-01-01', validTo: '2027-12-31' })
    expect(api.find('PATCH', '/amc/contracts/100')[0]?.body).not.toHaveProperty('status')
    // The AMC Reference Number was not changed, so it is not sent: the API keeps it.
    expect(api.find('PATCH', '/amc/contracts/100')[0]?.body).not.toHaveProperty('amcReference')
    expect(api.find('GET', '/amc/contracts/100/schedule/preview')).toHaveLength(0)
    // In the register (the Total AMC Value figure above it shows the same amount).
    expect(await within(screen.getByRole('table', { name: 'AMC contracts' })).findByText('1,800.000')).toBeInTheDocument()
  })

  const openEdit = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const reference = (await within(dialog).findByLabelText(/AMC Reference Number/)) as HTMLInputElement

    return { dialog, reference }
  }

  it('shows the AMC Reference Number editable, with its current value', async () => {
    amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    const { dialog, reference } = await openEdit()

    expect(reference).toHaveValue('AMC-0100')
    expect(reference).not.toHaveAttribute('readonly')
    expect(within(dialog).getByText(/Currently AMC-0100\. Each number can be used by one contract only\./)).toBeInTheDocument()
  })

  it('sends a changed AMC Reference Number, trimmed', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    const { dialog, reference } = await openEdit()

    await userEvent.clear(reference)
    await userEvent.type(reference, '  STSLV-AMC-2027-100 ')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PATCH', '/amc/contracts/100')[0]?.body).toMatchObject({ amcReference: 'STSLV-AMC-2027-100' })
  })

  it.each([
    ['', 'AMC Reference Number is required.'],
    ['AMC#100', 'AMC Reference Number may use letters, digits, spaces and - _ . / & only, and must start with a letter or digit.'],
  ])('refuses the edited AMC Reference Number %j before calling the API', async (value, message) => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts')
    const { dialog, reference } = await openEdit()

    await userEvent.clear(reference)
    if (value) await userEvent.type(reference, value)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await within(dialog).findByText(message)).toBeInTheDocument()
    expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(0)
  })

  it('shows a duplicate edited AMC Reference Number on its field and keeps what was typed', async () => {
    const DUPLICATE = 'AMC Reference Number already exists. Please enter a different number.'
    amcApi(ADMIN, {
      contracts: [FIRE],
      override: (request) =>
        request.method === 'PATCH' && request.path === '/amc/contracts/100' ? fail(409, 'CONFLICT', DUPLICATE, [{ field: 'amcReference', message: DUPLICATE }]) : undefined,
    })
    renderApp('/amc/contracts')
    const { dialog, reference } = await openEdit()

    await userEvent.clear(reference)
    await userEvent.type(reference, 'AMC-0200')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await within(dialog).findByText(DUPLICATE)).toBeInTheDocument()
    expect(reference).toHaveValue('AMC-0200')
    expect(reference).toHaveAttribute('aria-invalid', 'true')
  })

  it('asks for confirmation, showing the effect on the schedule, before changing the terms of an active contract', async () => {
    const api = amcApi(ADMIN, {
      contracts: [FIRE],
      preview: {
        validFrom: '2027-01-01',
        validTo: '2028-06-30',
        maintenanceFrequency: 'QUARTERLY',
        canApply: true,
        blockedReason: null,
        toCreate: [
          { periodStart: '2028-01-01', periodEnd: '2028-03-31', scheduledDate: '2028-01-01', visitAmount: '405.000' },
          { periodStart: '2028-04-01', periodEnd: '2028-06-30', scheduledDate: '2028-04-01', visitAmount: '405.000' },
        ],
        toRemove: [],
        keptCount: 4,
        blocking: [],
      },
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const validTo = await within(dialog).findByLabelText(/Valid to/)
    await userEvent.clear(validTo)
    await userEvent.type(validTo, '2028-06-30')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    const confirm = await screen.findByRole('dialog', { name: 'Confirm schedule change' })
    expect(confirm).toHaveTextContent('2 visit(s) will be added: 01 Jan 2028, 01 Apr 2028')
    expect(confirm).toHaveTextContent('0 untouched visit(s) will be removed')
    expect(confirm).toHaveTextContent('4 visit(s) will be kept exactly as they are')
    // Nothing has been saved yet.
    expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(0)
    expect(api.find('GET', '/amc/contracts/100/schedule/preview')[0]?.query.get('validTo')).toBe('2028-06-30')

    await userEvent.click(within(confirm).getByRole('button', { name: 'Save and update schedule' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.find('PATCH', '/amc/contracts/100')[0]?.body).toMatchObject({ validTo: '2028-06-30' })
    expect(screen.getByRole('status')).toHaveTextContent('2 visit(s) added to the schedule')
  })

  it('returns to the form with the entered values when the confirmation is declined', async () => {
    const api = amcApi(ADMIN, {
      contracts: [FIRE],
      preview: {
        validFrom: '2027-01-01',
        validTo: '2027-06-30',
        maintenanceFrequency: 'QUARTERLY',
        canApply: true,
        blockedReason: null,
        toCreate: [],
        toRemove: [{ id: '503', sequenceNo: 4, periodStart: '2027-10-01', periodEnd: '2027-12-31' }],
        keptCount: 3,
        blocking: [],
      },
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const validTo = await within(dialog).findByLabelText(/Valid to/)
    await userEvent.clear(validTo)
    await userEvent.type(validTo, '2027-06-30')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    const confirm = await screen.findByRole('dialog', { name: 'Confirm schedule change' })
    expect(confirm).toHaveTextContent('1 untouched visit(s) will be removed: 01 Oct 2027')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Back' }))

    const form = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    expect(within(form).getByLabelText(/Valid to/)).toHaveValue('2027-06-30')
    expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(0)
  })

  it('explains why terms cannot be applied, and saves nothing', async () => {
    const api = amcApi(ADMIN, {
      contracts: [FIRE],
      preview: {
        validFrom: '2027-01-01',
        validTo: '2027-06-30',
        maintenanceFrequency: 'QUARTERLY',
        canApply: false,
        blockedReason: '1 visit(s) that have been worked on, edited or rescheduled fall outside the new validity period (2027-10-01).',
        toCreate: [],
        toRemove: [],
        keptCount: 4,
        blocking: [{ id: '503', sequenceNo: 4, periodStart: '2027-10-01', periodEnd: '2027-12-31' }],
      },
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit AMC Contract' })
    const validTo = await within(dialog).findByLabelText(/Valid to/)
    await userEvent.clear(validTo)
    await userEvent.type(validTo, '2027-06-30')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('fall outside the new validity period (2027-10-01)')
    expect(api.find('PATCH', '/amc/contracts/100')).toHaveLength(0)
  })
})

describe('contract status', () => {
  it('activates a draft from its page', async () => {
    const api = amcApi(ADMIN, { contracts: [DRAFT] })
    renderApp('/amc/contracts/101')

    const page = await openedContract('Test Hotel Two — CCTV')
    expect(await page.findByText(/A draft has no schedule/)).toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: 'Activate' }))
    const confirm = await screen.findByRole('dialog', { name: 'Activate contract' })
    expect(confirm).toHaveTextContent('The maintenance schedule is generated')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Activate contract' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/101/status')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/101/status')[0]?.body).toEqual({ status: 'ACTIVE' })
    expect(await screen.findByRole('status')).toHaveTextContent('The contract is now Active.')
  })

  it('cancels a contract and cancels its open visits only when that is ticked', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts/100')

    const page = await openedContract('Test Hotel One — FIRE')
    await userEvent.click(page.getByRole('button', { name: 'Cancel contract' }))

    const confirm = await screen.findByRole('dialog', { name: 'Cancel contract' })
    expect(confirm).toHaveTextContent('This contract has 3 visit(s) that are not completed.')
    const checkbox = within(confirm).getByLabelText('Also cancel the scheduled and postponed visits of this contract')
    expect(checkbox).not.toBeChecked()

    await userEvent.click(checkbox)
    // The reason is required: nothing is sent until it is entered.
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel contract' }))
    expect(await within(confirm).findByText('Enter the reason for cancelling this contract.')).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts/100/status')).toHaveLength(0)

    await userEvent.type(within(confirm).getByLabelText(/Reason for cancelling/), '  Client closed the site ')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel contract' }))

    await waitFor(() => expect(api.find('POST', '/amc/contracts/100/status')).toHaveLength(1))
    expect(api.find('POST', '/amc/contracts/100/status')[0]?.body).toEqual({ status: 'CANCELLED', cancelOpenVisits: true, reason: 'Client closed the site' })
    expect(await screen.findByRole('status')).toHaveTextContent('is now Cancelled. 3 visit(s) cancelled.')
  })

  it('goes back to the contract page without changing anything', async () => {
    const api = amcApi(ADMIN, { contracts: [FIRE] })
    renderApp('/amc/contracts/100')

    const page = await openedContract('Test Hotel One — FIRE')
    await userEvent.click(page.getByRole('button', { name: 'Mark as expired' }))
    const confirm = await screen.findByRole('dialog', { name: 'Mark contract as expired' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Back' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Test Hotel One — FIRE' })).toBeInTheDocument()
    expect(api.find('POST', '/amc/contracts/100/status')).toHaveLength(0)
  })
})

describe('contract permissions', () => {
  it('offers a view-only role no way to add, edit or change the status', async () => {
    amcApi(VIEWER, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    expect(await screen.findByRole('link', { name: 'View Test Hotel One FIRE' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add Contract' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('link', { name: 'View Test Hotel One FIRE' }))
    const page = await openedContract('Test Hotel One — FIRE')
    for (const name of ['Edit', 'Activate', 'Mark as expired', 'Reactivate', 'Cancel contract']) {
      expect(page.queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  it('refuses the page to a role without AMC Contracts access, without requesting its data', async () => {
    const api = amcApi(ACCOUNTANT, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(api.find('GET', '/amc/contracts')).toHaveLength(0)
  })

  it('shows the message from the API when a status change is refused', async () => {
    amcApi(ADMIN, {
      contracts: [FIRE],
      override: (request) =>
        request.path === '/amc/contracts/100/status' ? fail(403, 'FORBIDDEN', 'You do not have permission to perform this action.') : undefined,
    })
    renderApp('/amc/contracts/100')

    const page = await openedContract('Test Hotel One — FIRE')
    await userEvent.click(page.getByRole('button', { name: 'Mark as expired' }))
    const confirm = await screen.findByRole('dialog', { name: 'Mark contract as expired' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Mark contract as expired' }))

    expect(await within(confirm).findByRole('alert')).toHaveTextContent('You do not have permission to perform this action.')
  })
})

// Holds AMC Contracts Delete (cancellation) but is not Super Admin.
const CONTRACT_MANAGER = {
  id: '8',
  email: 'manager@example.com',
  fullName: 'Mira Manager',
  roles: [{ id: '8', code: 'ADMINISTRATOR', name: 'Service Dept' }],
  permissions: ['AMC_CONTRACTS:VIEW', 'AMC_CONTRACTS:CREATE', 'AMC_CONTRACTS:EDIT', 'AMC_CONTRACTS:DELETE'],
}

describe('move a contract to the Recycle Bin (Super Admin only)', () => {
  it('asks first, says nothing is removed, Cancel does nothing, and confirming moves it', async () => {
    const api = amcApi(ADMIN, {
      contracts: [FIRE, DRAFT],
      override: (request) => (request.method === 'DELETE' && request.path === '/amc/contracts/101' ? { status: 200, body: { success: true, data: { deleted: true } } } : undefined),
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Delete Test Hotel Two CCTV' }))
    let dialog = await screen.findByRole('dialog', { name: 'Move contract to the Recycle Bin' })
    expect(dialog).toHaveTextContent('Move the contract for Test Hotel Two CCTV to the Recycle Bin?')
    expect(dialog).toHaveTextContent('Nothing is removed: its services, service reports, quotations, invoices, documents and history are kept')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.find('DELETE', '/amc/contracts/101')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Delete Test Hotel Two CCTV' }))
    dialog = await screen.findByRole('dialog', { name: 'Move contract to the Recycle Bin' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move to Recycle Bin' }))

    await waitFor(() => expect(api.find('DELETE', '/amc/contracts/101')).toHaveLength(1))
    expect(await screen.findByRole('status')).toHaveTextContent('The contract for Test Hotel Two CCTV was moved to the Recycle Bin.')
  })

  it('shows the API reason in the popup when a contract cannot be moved', async () => {
    amcApi(ADMIN, {
      contracts: [FIRE],
      override: (request) =>
        request.method === 'DELETE' && request.path === '/amc/contracts/100' ? fail(409, 'CONFLICT', 'The contract cannot be moved to the Recycle Bin: it was renewed as AMC-0102.') : undefined,
    })
    renderApp('/amc/contracts')

    await userEvent.click(await screen.findByRole('button', { name: 'Delete Test Hotel One FIRE' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move contract to the Recycle Bin' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move to Recycle Bin' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('it was renewed as AMC-0102.')
    expect(screen.getByRole('link', { name: 'View Test Hotel One FIRE' })).toBeInTheDocument()
  })

  it('offers no Delete to a role that holds AMC Contracts Delete but is not Super Admin', async () => {
    amcApi(CONTRACT_MANAGER, { contracts: [FIRE] })
    renderApp('/amc/contracts')

    expect(await screen.findByRole('button', { name: 'Edit Test Hotel One FIRE' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument()
  })
})
