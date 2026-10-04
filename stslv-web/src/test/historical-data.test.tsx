import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '../lib/types'
import type { ReviewRow, ReviewSummary } from '../pages/historical/types'
import { ACCOUNTANT, ADMIN, fail, mockApi, ok, renderApp, signIn, type MockReply, type MockRequest } from './helpers'

// The Historical Data Review page. Every name, number and amount is invented.

const row = (overrides: Partial<ReviewRow> & Pick<ReviewRow, 'id' | 'kind' | 'identifier'>): ReviewRow => ({
  batchId: '1',
  status: 'IMPORTED',
  source: { workbook: 'Jobs.xlsx', sheet: 'Register', row: 6, cell: '' },
  rawValues: {},
  sourceColumns: [],
  proposedValues: {},
  holdReasons: [],
  warnings: [],
  invoiceReference: null,
  link: null,
  ...overrides,
})

const IMPORTED_JOB = row({
  id: '101',
  kind: 'PROJECT',
  identifier: 'JOB0102',
  // As the API returns them: the object's keys in no particular order, the sheet's column order beside it.
  rawValues: { PROFIT: null, Client: 'ECHO ', Month: 'JAN', 'S. No': '102', Status: 'Completed', 'Job Value': '1577.276', 'Job Number': 'JOB0102', 'INVOICE NUMBER': '9002, 9003' },
  sourceColumns: ['S. No', 'Status', 'Month', 'Job Number', 'Client', 'Job Value', 'PROFIT', 'INVOICE NUMBER'],
  proposedValues: {
    jobNumber: 'JOB0102',
    clientName: 'ECHO',
    description: 'Panel repair',
    sourceJobDate: 'JAN 2025',
    legacyStatus: 'Completed',
    jobValue: '1577.276',
    vatRate: '5.000',
    vatAmount: '78.864',
    grandValue: '1656.140',
    legacyProfit: null,
    status: 'HISTORICAL',
  },
  invoiceReference: { rawCell: '9002, 9003', numbers: ['9002', '9003'], classification: 'JOB_HAS_MULTIPLE_INVOICES', notes: ['The cell lists 2 invoices. How the job value divides between them is not in the register.'] },
  link: { type: 'project', id: '55', label: 'JOB0102' },
})

const BLANK_JOB = row({
  id: '102',
  kind: 'PROJECT',
  identifier: 'JOB0108',
  status: 'PROVISIONAL',
  source: { workbook: 'Jobs.xlsx', sheet: 'Register', row: 12, cell: '' },
  rawValues: { 'Job Number': 'JOB0108', Client: 'JULIET', 'Job Value': null, 'INVOICE NUMBER': null },
  proposedValues: { jobNumber: 'JOB0108', clientName: 'JULIET', description: 'Building rectification', sourceJobDate: 'MAY 2025', legacyStatus: 'Completed', jobValue: null, vatRate: null, vatAmount: null, grandValue: null, legacyProfit: null, status: 'HISTORICAL' },
  holdReasons: [{ code: 'JOB_VALUE_BLANK', message: 'The job value is empty and cannot be recovered from the workbooks. It is not treated as zero: the client must supply it.' }],
  invoiceReference: { rawCell: null, numbers: [], classification: 'NO_INVOICE_REFERENCE', notes: [] },
})

const ALIAS_NAME = row({
  id: '103',
  kind: 'CLIENT',
  identifier: 'DELTAHOUSE',
  status: 'PROVISIONAL',
  source: { workbook: 'Jobs.xlsx', sheet: 'Register', row: 15, cell: '' },
  rawValues: { Client: 'DELTAHOUSE' },
  proposedValues: {
    rawName: 'DELTAHOUSE',
    normalizedName: 'DELTAHOUSE',
    masterName: 'DELTA HOUSE',
    classification: 'PROPOSED_ALIAS',
    outcome: 'HELD_ALIAS_NOT_APPROVED',
    mappingReason: 'spacing only: identical once spaces and punctuation are removed ("DELTAHOUSE")',
    occurrences: { contracts: 0, schedule: 0, jobs: 1 },
  },
  holdReasons: [{ code: 'CLIENT_ALIAS_NOT_APPROVED', message: 'Client "DELTAHOUSE" is a likely alias of "DELTA HOUSE" that has not been approved.' }],
})

const VISIT = row({
  id: '104',
  kind: 'AMC_VISIT',
  identifier: 'GAMMA VILLA AUTOMATION Q1',
  status: 'PROVISIONAL',
  source: { workbook: 'Schedule.xlsx', sheet: 'Schedule', row: 6, cell: 'N6' },
  rawValues: { Client: 'GAMMA VILLA AUTOMATION Q1', 'Inv. No.': 'DONE', Value: '6000' },
  proposedValues: { clientName: 'GAMMA', systemDescription: 'Automation', sourceLabel: 'Q1', sequenceNo: 1, periodStart: '2026-03-01', periodEnd: '2026-05-31', visitAmount: '6000.000', status: 'HISTORICAL' },
  holdReasons: [
    { code: 'CONTRACT_HELD', message: 'Its contract (register row 7) is held: CLIENT_IDENTITY_UNCONFIRMED, MAINTENANCE_FREQUENCY_UNRESOLVED.' },
    { code: 'SOME_NEW_REASON', message: 'A reason this page has no name for.' },
  ],
  invoiceReference: { rawCell: 'DONE', numbers: [], classification: 'NON_NUMERIC_MARKER', notes: ['"DONE" is not an invoice number. Its meaning is unconfirmed and it is not read as one.'] },
})

const ROWS = [IMPORTED_JOB, BLANK_JOB, ALIAS_NAME, VISIT]

const SUMMARY: ReviewSummary = {
  batches: [
    {
      id: '1',
      label: 'Historical Excel import',
      cutoverDate: '2026-10-03',
      sourceFiles: [{ name: 'Contracts.xlsx', sha256: 'a' }, { name: 'Schedule.xlsx', sha256: 'b' }, { name: 'Jobs.xlsx', sha256: 'c' }],
      createdAt: '2026-10-03T08:00:00.000Z',
      rows: 43,
    },
  ],
  totals: { records: 43, imported: 20, provisional: 23 },
  byKind: [
    { kind: 'CLIENT', total: 14, imported: 8, provisional: 6, importedAmount: null, provisionalAmount: null, withoutAmount: 0 },
    { kind: 'AMC_CONTRACT', total: 3, imported: 2, provisional: 1, importedAmount: '4700.000', provisionalAmount: '12000.000', withoutAmount: 0 },
    { kind: 'AMC_VISIT', total: 12, imported: 2, provisional: 10, importedAmount: '800.000', provisionalAmount: '15900.000', withoutAmount: 0 },
    { kind: 'PROJECT', total: 14, imported: 8, provisional: 6, importedAmount: '4810.609', provisionalAmount: '6641.000', withoutAmount: 1 },
  ],
  clientNames: { distinct: 13, clients: 5 },
  holdReasons: [
    { kind: 'AMC_VISIT', code: 'CONTRACT_HELD', count: 4 },
    { kind: 'PROJECT', code: 'DUPLICATE_JOB_NUMBER', count: 2 },
    { kind: 'PROJECT', code: 'JOB_VALUE_BLANK', count: 1 },
  ],
  invoiceReferences: {
    byClassification: [
      { kind: 'AMC_VISIT', classification: 'NON_NUMERIC_MARKER', count: 2 },
      { kind: 'PROJECT', classification: 'INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT', count: 2 },
      { kind: 'PROJECT', classification: 'NON_NUMERIC_MARKER', count: 1 },
    ],
    numbersMentioned: 9,
    distinctNumbers: 8,
  },
}

const EMPTY_SUMMARY: ReviewSummary = {
  batches: [],
  totals: { records: 0, imported: 0, provisional: 0 },
  byKind: SUMMARY.byKind.map((kind) => ({ ...kind, total: 0, imported: 0, provisional: 0, importedAmount: kind.importedAmount === null ? null : '0.000', provisionalAmount: kind.provisionalAmount === null ? null : '0.000', withoutAmount: 0 })),
  clientNames: { distinct: 0, clients: 0 },
  holdReasons: [],
  invoiceReferences: { byClassification: [], numbersMentioned: 0, distinctNumbers: 0 },
}

/** A stand-in for the review API that applies the kind, status and reason filters it is sent. */
function reviewApi(user: SessionUser, options: { summary?: ReviewSummary; rows?: ReviewRow[]; override?: (request: MockRequest) => MockReply | undefined } = {}) {
  signIn()

  return mockApi((request) => {
    const overridden = options.override?.(request)
    if (overridden) return overridden

    if (request.path === '/auth/me') return ok({ user })
    if (request.method === 'GET' && request.path === '/historical-data/summary') return ok(options.summary ?? SUMMARY)
    if (request.method === 'GET' && request.path === '/historical-data/rows') {
      const kind = request.query.get('kind')
      const status = request.query.get('status')
      const reason = request.query.get('reason')
      const search = (request.query.get('search') ?? '').toLowerCase()
      const items = (options.rows ?? ROWS)
        .filter((item) => kind === 'all' || item.kind === kind)
        .filter((item) => status === 'all' || item.status === (status === 'imported' ? 'IMPORTED' : 'PROVISIONAL'))
        .filter((item) => !reason || item.holdReasons.some((held) => held.code === reason))
        .filter((item) => item.identifier.toLowerCase().includes(search))

      return ok({ items, total: items.length, page: 1, pageSize: 25 })
    }

    return undefined
  })
}

const recordsTable = () => screen.findByRole('table', { name: 'Historical source records' })
const lastRowsQuery = (api: ReturnType<typeof reviewApi>) => api.find('GET', '/historical-data/rows').at(-1)?.query

describe('access', () => {
  it('is in the navigation of a user who may view it, and opens the page', async () => {
    reviewApi(ADMIN)
    renderApp('/historical-data')

    expect(await screen.findByRole('heading', { name: 'Historical Data Review', level: 1 })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Historical Data' })).toHaveAttribute('aria-current', 'page')
  })

  it('is refused to a role without the permission, and asks the API for nothing', async () => {
    const api = reviewApi(ACCOUNTANT)
    renderApp('/historical-data')

    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Historical Data' })).not.toBeInTheDocument()
    expect(api.requests.filter((request) => request.path.startsWith('/historical-data'))).toEqual([])
  })
})

describe('summary', () => {
  it('shows imported and provisional records by type, with exact amounts', async () => {
    reviewApi(ADMIN)
    renderApp('/historical-data')

    const table = await screen.findByRole('table', { name: 'Summary of historical records by type' })
    const cells = (name: RegExp) => within(within(table).getByRole('row', { name })).getAllByRole('cell').map((cell) => cell.textContent)

    expect(cells(/^Projects \/ jobs/)).toEqual(['14', '8', '6', '4,810.609', '6,641.000'])
    expect(cells(/^AMC visit periods/)).toEqual(['12', '2', '10', '800.000', '15,900.000'])
    expect(cells(/^AMC contracts/)).toEqual(['3', '2', '1', '4,700.000', '12,000.000'])
    // Client names carry no amount.
    expect(cells(/^Client names/)).toEqual(['14', '8', '6', '—', '—'])
    expect(cells(/^All records/)).toEqual(['43', '20', '23', '', ''])
    // A missing value is said to be missing, not added as zero.
    expect(within(table).getByText('1 with no job value in the source (not counted as zero)')).toBeInTheDocument()
    expect(within(table).getByText('13 different names, leading to 5 client records so far')).toBeInTheDocument()
  })

  it('says the page is read-only and that provisional records affect nothing', async () => {
    reviewApi(ADMIN)
    renderApp('/historical-data')

    await recordsTable()

    expect(screen.getByText(/exist only on this page: they are in no dashboard figure, schedule or invoice list\. This page is read-only\./)).toBeInTheDocument()
    expect(screen.getByText(/9 invoice numbers mentioned, 8 different\. They are kept for reference only: no invoice record has been created from them\./)).toBeInTheDocument()
    // The same classification of two kinds of record is one line.
    const invoices = screen.getByRole('heading', { name: 'Invoice references in the Excel files' }).parentElement as HTMLElement

    expect(within(invoices).getByText('A word, not an invoice number').nextSibling).toHaveTextContent('3')
  })

  it('shows an empty state before any data is loaded', async () => {
    const api = reviewApi(ADMIN, { summary: EMPTY_SUMMARY, rows: [] })
    renderApp('/historical-data')

    expect(await screen.findByText('No historical data has been loaded yet')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(api.requests.every((request) => request.method === 'GET')).toBe(true)
  })

  it('shows an error with a way to try again when the summary cannot be read', async () => {
    let failing = true

    reviewApi(ADMIN, { override: (request) => (failing && request.path === '/historical-data/summary' ? fail(500, 'INTERNAL_ERROR', 'An unexpected error occurred.') : undefined) })
    renderApp('/historical-data')

    expect(await screen.findByText('An unexpected error occurred.')).toBeInTheDocument()

    failing = false
    await userEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0] as HTMLElement)

    expect(await screen.findByRole('table', { name: 'Summary of historical records by type' })).toBeInTheDocument()
  })
})

describe('source records', () => {
  it('lists each record with its source reference, value, invoice cell and status', async () => {
    reviewApi(ADMIN)
    renderApp('/historical-data')

    const table = await recordsTable()
    const imported = within(table).getByRole('row', { name: /JOB0102/ })
    const blank = within(table).getByRole('row', { name: /JOB0108/ })
    const visit = within(table).getByRole('row', { name: /GAMMA VILLA AUTOMATION Q1/ })

    expect(within(table).getAllByRole('row')).toHaveLength(ROWS.length + 1)
    expect(within(imported).getByText('Jobs.xlsx · Register · row 6')).toBeInTheDocument()
    expect(within(imported).getByText('1,577.276')).toBeInTheDocument()
    expect(within(imported).getByText('9002, 9003')).toBeInTheDocument()
    expect(within(imported).getByText('Several invoices on one job')).toBeInTheDocument()
    expect(within(imported).getByText('Imported')).toBeInTheDocument()
    // A job with no value shows that it has none. It is not shown as 0.000.
    expect(within(blank).getByText('Not given')).toBeInTheDocument()
    expect(within(blank).queryByText('0.000')).not.toBeInTheDocument()
    expect(within(blank).getByText('Provisional')).toBeInTheDocument()
    expect(within(blank).getByText('Job value is empty')).toBeInTheDocument()
    // The cell is named where one sheet row holds several records.
    expect(within(visit).getByText('Schedule.xlsx · Schedule · row 6 (cell N6)')).toBeInTheDocument()
    expect(within(visit).getByText(/Its contract is provisional \(\+1 more\)/)).toBeInTheDocument()
  })

  it('links an imported record to its page, and a provisional record to nothing', async () => {
    reviewApi(ADMIN)
    renderApp('/historical-data')

    const table = await recordsTable()

    expect(within(table).getByRole('link', { name: 'Open project JOB0102' })).toHaveAttribute('href', '/projects/55')
    expect(within(within(table).getByRole('row', { name: /JOB0108/ })).queryByRole('link')).not.toBeInTheDocument()
  })

  it('does not link to a module the user may not open', async () => {
    reviewApi({ ...ADMIN, permissions: ['DASHBOARD:VIEW', 'HISTORICAL_DATA:VIEW'] })
    renderApp('/historical-data')

    const table = await recordsTable()

    expect(within(table).queryByRole('link')).not.toBeInTheDocument()
    expect(within(within(table).getByRole('row', { name: /JOB0102/ })).getByText('JOB0102', { selector: 'span span' })).toBeInTheDocument()
  })

  it('filters through the API by type, status, open question, invoice reference and text', async () => {
    const api = reviewApi(ADMIN)
    renderApp('/historical-data')
    await recordsTable()

    expect(Object.fromEntries(lastRowsQuery(api) ?? [])).toEqual({ kind: 'all', status: 'all', invoice: 'all', page: '1', pageSize: '25' })

    await userEvent.selectOptions(screen.getByLabelText('Record type'), 'PROJECT')
    await userEvent.selectOptions(screen.getByLabelText('Review status'), 'provisional')

    await waitFor(() => expect(screen.queryByText('JOB0102')).not.toBeInTheDocument())
    expect(screen.getByText('JOB0108')).toBeInTheDocument()
    expect(lastRowsQuery(api)?.get('kind')).toBe('PROJECT')
    expect(lastRowsQuery(api)?.get('status')).toBe('provisional')

    await userEvent.selectOptions(screen.getByLabelText('Open question'), 'DUPLICATE_JOB_NUMBER')
    await userEvent.selectOptions(screen.getByLabelText('Invoice reference'), 'shared')
    await waitFor(() => expect(lastRowsQuery(api)?.get('invoice')).toBe('shared'))
    expect(lastRowsQuery(api)?.get('reason')).toBe('DUPLICATE_JOB_NUMBER')

    // Nothing matches: the filters can be cleared in one step.
    await userEvent.click(await screen.findByRole('button', { name: 'Clear filters' }))
    await recordsTable()
    expect(screen.getByLabelText('Record type')).toHaveValue('all')

    await userEvent.type(screen.getByLabelText('Search'), 'gamma')
    await waitFor(() => expect(lastRowsQuery(api)?.get('search')).toBe('gamma'))
    await waitFor(() => expect(screen.queryByText('JOB0108')).not.toBeInTheDocument())
  })

  it('opens the records behind an open question from the summary', async () => {
    const api = reviewApi(ADMIN)
    renderApp('/historical-data')
    await recordsTable()

    await userEvent.click(screen.getByRole('button', { name: 'Show 1 projects / jobs: Job value is empty' }))

    await waitFor(() => expect(lastRowsQuery(api)?.get('reason')).toBe('JOB_VALUE_BLANK'))
    expect(lastRowsQuery(api)?.get('kind')).toBe('PROJECT')
    expect(screen.getByLabelText('Review status')).toHaveValue('provisional')
    await waitFor(() => expect(screen.queryByText('JOB0102')).not.toBeInTheDocument())
  })
})

describe('one record', () => {
  it('shows the original Excel values beside what was imported', async () => {
    reviewApi(ADMIN)
    renderApp('/historical-data')
    await recordsTable()

    await userEvent.click(screen.getByRole('button', { name: 'View Project / job JOB0102, row 6' }))

    const dialog = await screen.findByRole('dialog', { name: 'Project / job: JOB0102' })
    const section = (title: string) => within(dialog).getByRole('heading', { name: title }).parentElement as HTMLElement
    const value = (container: HTMLElement, label: string) => within(container).getByText(label).nextSibling

    // The trailing space of the source is the original value; the import proposes the name without it.
    expect(value(section('Original Excel values'), 'Client')?.textContent).toBe('ECHO ')
    expect(value(section('Original Excel values'), 'Job Value')).toHaveTextContent('1577.276')
    expect(value(section('Original Excel values'), 'PROFIT')).toHaveTextContent('(empty)')
    // In the order of the sheet's columns.
    expect(within(section('Original Excel values')).getAllByRole('term').map((term) => term.textContent)).toEqual(['S. No', 'Status', 'Month', 'Job Number', 'Client', 'Job Value', 'PROFIT', 'INVOICE NUMBER'])
    expect(value(section('As imported'), 'Client')).toHaveTextContent('ECHO')
    expect(value(section('As imported'), 'Job value')).toHaveTextContent('1,577.276')
    expect(value(section('As imported'), 'VAT rate')).toHaveTextContent('5%')
    expect(value(section('As imported'), 'Grand value')).toHaveTextContent('1,656.140')
    expect(value(section('As imported'), 'Status in the source')).toHaveTextContent('Completed')
    expect(value(section('As imported'), 'Status in the application')).toHaveTextContent('Historical')
    expect(value(section('As imported'), 'Profit in the source (not the job margin)')).toHaveTextContent('Not given in the source')
    expect(within(dialog).getByText(/Jobs\.xlsx · Register · row 6/)).toBeInTheDocument()
    expect(value(section('Invoice reference in the source'), 'Invoice numbers')).toHaveTextContent('9002, 9003')
    expect(within(dialog).getByText('Kept for reference only. No invoice record has been created from it.')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Open project JOB0102' })).toHaveAttribute('href', '/projects/55')
  })

  it('explains why a record is provisional and offers no way to change it', async () => {
    const api = reviewApi(ADMIN)
    renderApp('/historical-data')
    await recordsTable()

    await userEvent.click(screen.getByRole('button', { name: 'View Project / job JOB0108, row 12' }))

    const dialog = await screen.findByRole('dialog', { name: 'Project / job: JOB0108' })

    expect(within(dialog).getByText(/This record is provisional\. It is shown here exactly as it is in the Excel file and has not been added to the application/)).toBeInTheDocument()
    expect(within(dialog).getByText('Job value is empty')).toBeInTheDocument()
    expect(within(dialog).getByText(/It is not treated as zero: the client must supply it\./)).toBeInTheDocument()
    expect(within(dialog).getByRole('heading', { name: 'Proposed mapping (not applied)' })).toBeInTheDocument()
    // The missing value is missing in both columns: no amount is made up.
    expect(within(dialog).getByText('Job Value').nextSibling).toHaveTextContent('(empty)')
    expect(within(dialog).getByText('Job value').nextSibling).toHaveTextContent('Not given in the source')
    expect(within(dialog).getByText('Grand value').nextSibling).toHaveTextContent('Not given in the source')
    expect(within(dialog).queryByText('0.000')).not.toBeInTheDocument()
    // Read-only: nothing to type in, nothing to save, no link to a record that does not exist.
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument()
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent || button.getAttribute('aria-label'))).toEqual(['Close', 'Close'])

    await userEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[1] as HTMLElement)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // The whole visit sent nothing but reads.
    expect(api.requests.every((request) => request.method === 'GET')).toBe(true)
  })

  it('shows a raw client name with its proposed mapping and why', async () => {
    reviewApi(ADMIN)
    renderApp('/historical-data')
    await recordsTable()

    await userEvent.click(screen.getByRole('button', { name: 'View Client name DELTAHOUSE, row 15' }))

    const dialog = await screen.findByRole('dialog', { name: 'Client name: DELTAHOUSE' })

    expect(within(dialog).getByText('Client record').nextSibling).toHaveTextContent('DELTA HOUSE')
    expect(within(dialog).getByText('Mapping').nextSibling).toHaveTextContent('Proposed alias')
    expect(within(dialog).getByText('Result').nextSibling).toHaveTextContent('Alias not yet confirmed')
    expect(within(dialog).getByText('Used in').nextSibling).toHaveTextContent('Contract register 0 · AMC schedule 0 · Job register 1')
    expect(within(dialog).getByText('Client name is a likely alias, not yet confirmed')).toBeInTheDocument()
  })

  it('shows a word in the invoice cell as a word, and names a reason it has no label for', async () => {
    reviewApi(ADMIN)
    renderApp('/historical-data')
    await recordsTable()

    await userEvent.click(screen.getByRole('button', { name: 'View AMC visit period GAMMA VILLA AUTOMATION Q1, row 6' }))

    const dialog = await screen.findByRole('dialog', { name: 'AMC visit period: GAMMA VILLA AUTOMATION Q1' })

    expect(within(dialog).getByText('Invoice cell').nextSibling).toHaveTextContent('DONE')
    expect(within(dialog).getByText('Reading').nextSibling).toHaveTextContent('A word, not an invoice number')
    expect(within(dialog).getByText('Invoice numbers').nextSibling).toHaveTextContent('None')
    expect(within(dialog).getByText('Period start').nextSibling).toHaveTextContent('1 Mar 2026')
    expect(within(dialog).getByText('Period value').nextSibling).toHaveTextContent('6,000.000')
    expect(within(dialog).getByText('Some new reason')).toBeInTheDocument()
  })
})
