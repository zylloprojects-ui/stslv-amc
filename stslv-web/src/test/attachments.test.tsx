import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '../components/AttachmentsPanel'
import { ADMIN, fail, ok, renderApp, type MockReply, type MockRequest } from './helpers'
import { amcApi, makeContract, VIEWER } from './amc-helpers'

// Documents on the contract page (the shared attachments panel). Every file here is invented.

const DOC: Attachment = {
  id: '5',
  documentId: '5',
  version: 2,
  isCurrent: true,
  category: 'SIGNED_CONTRACT',
  title: 'Signed contract',
  originalName: 'signed.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
  notes: 'Countersigned',
  uploadedBy: { id: '1', fullName: 'Asha Admin' },
  uploadedAt: '2026-10-20T08:00:00.000Z',
  versionCount: 2,
}

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }))
})
afterEach(() => {
  vi.restoreAllMocks()
})

function documentsApi(user = ADMIN, docs: Attachment[] = [DOC], extra?: (request: MockRequest) => MockReply | undefined) {
  return amcApi(user, {
    contracts: [makeContract()],
    override: (request) => {
      const overridden = extra?.(request)
      if (overridden) return overridden
      if (request.method === 'GET' && request.path === '/attachments') return ok(docs)
      if (request.method === 'GET' && request.path === '/attachments/5/versions') return ok([DOC, { ...DOC, id: '4', version: 1, isCurrent: false, originalName: 'draft.pdf', notes: null }])
      if (request.method === 'POST' && request.path === '/attachments') return ok({ ...DOC, id: '9', version: 1 }, 201)
      if (request.method === 'GET' && request.path === '/attachments/5/download') return ok({})
      return undefined
    },
  })
}

async function documents() {
  await userEvent.click(await screen.findByRole('tab', { name: /^Documents/ }))

  return within(screen.getByRole('tabpanel'))
}

describe('contract documents', () => {
  it('lists the current documents with type, file, version and uploader, asking for this contract only', async () => {
    const api = documentsApi()
    renderApp('/amc/contracts/100')

    const panel = await documents()
    const table = await panel.findByRole('table', { name: 'Documents' })
    const row = within(table).getAllByRole('row')[1] as HTMLElement

    expect(row).toHaveTextContent('Signed contract')
    expect(row).toHaveTextContent('signed.pdf')
    expect(row).toHaveTextContent('2.0 KB')
    expect(row).toHaveTextContent('2 of 2')
    expect(row).toHaveTextContent('Asha Admin')
    const request = api.find('GET', '/attachments')[0]
    expect(request?.query.get('entityType')).toBe('amc_contracts')
    expect(request?.query.get('entityId')).toBe('100')
  })

  it('shows every version of a document', async () => {
    documentsApi()
    renderApp('/amc/contracts/100')

    const panel = await documents()
    await userEvent.click(await panel.findByRole('button', { name: 'Versions of Signed contract' }))
    const dialog = await screen.findByRole('dialog', { name: 'Versions of "Signed contract"' })
    const items = within(within(dialog).getByRole('list', { name: 'Versions, newest first' })).getAllByRole('listitem')

    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Version 2Current')
    expect(items[1]).toHaveTextContent('draft.pdf')
  })

  it('downloads through the API with the session, not a public link', async () => {
    const api = documentsApi()
    renderApp('/amc/contracts/100')

    const panel = await documents()
    await userEvent.click(await panel.findByRole('button', { name: 'Download Signed contract' }))

    await waitFor(() => expect(api.find('GET', '/attachments/5/download')).toHaveLength(1))
    expect(api.find('GET', '/attachments/5/download')[0]?.authorization).toBe('Bearer test-token')
    expect(panel.queryByRole('link', { name: /signed\.pdf/ })).not.toBeInTheDocument()
  })

  it('requires a title and a file before uploading, then uploads to this contract', async () => {
    const api = documentsApi(ADMIN, [])
    renderApp('/amc/contracts/100')

    const panel = await documents()
    expect(await panel.findByText('No documents attached yet')).toBeInTheDocument()
    await userEvent.click(panel.getByRole('button', { name: 'Attach document' }))
    const dialog = await screen.findByRole('dialog', { name: 'Attach document' })

    await userEvent.click(within(dialog).getByRole('button', { name: 'Upload' }))
    expect(await within(dialog).findByText('Choose a file to upload.')).toBeInTheDocument()
    expect(within(dialog).getByText('Title is required.')).toBeInTheDocument()
    expect(api.find('POST', '/attachments')).toHaveLength(0)

    await userEvent.selectOptions(within(dialog).getByLabelText(/Document type/), 'LPO')
    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Client LPO')
    await userEvent.upload(within(dialog).getByLabelText(/^File/), new File(['%PDF-1.4'], 'lpo.pdf', { type: 'application/pdf' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Upload' }))

    await waitFor(() => expect(api.find('POST', '/attachments')).toHaveLength(1))
    const upload = api.find('POST', '/attachments')[0]
    expect(upload?.query.get('entityType')).toBe('amc_contracts')
    expect(upload?.query.get('entityId')).toBe('100')
    expect(upload?.query.get('category')).toBe('LPO')
    expect(upload?.query.get('title')).toBe('Client LPO')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Attach document' })).not.toBeInTheDocument())
  })

  it('shows the reason the API refuses a file', async () => {
    documentsApi(ADMIN, [], (request) =>
      request.method === 'POST' && request.path === '/attachments'
        ? fail(400, 'VALIDATION_ERROR', 'Only PDF, PNG and JPEG files can be uploaded.', [{ field: 'file', message: 'Only PDF, PNG and JPEG files can be uploaded.' }])
        : undefined,
    )
    renderApp('/amc/contracts/100')

    const panel = await documents()
    await userEvent.click(await panel.findByRole('button', { name: 'Attach document' }))
    const dialog = await screen.findByRole('dialog', { name: 'Attach document' })
    await userEvent.type(within(dialog).getByLabelText(/Title/), 'Scan')
    await userEvent.upload(within(dialog).getByLabelText(/^File/), new File(['x'], 'scan.pdf', { type: 'application/pdf' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Upload' }))

    expect(await within(dialog).findByText('Only PDF, PNG and JPEG files can be uploaded.')).toBeInTheDocument()
  })

  it('offers a view-only role no upload or replace', async () => {
    documentsApi(VIEWER)
    renderApp('/amc/contracts/100')

    const panel = await documents()
    await panel.findByRole('table', { name: 'Documents' })
    expect(panel.queryByRole('button', { name: 'Attach document' })).not.toBeInTheDocument()
    expect(panel.queryByRole('button', { name: /^Replace/ })).not.toBeInTheDocument()
    expect(panel.getByRole('button', { name: 'Download Signed contract' })).toBeInTheDocument()
  })

  it('explains when the database update or the storage is missing', async () => {
    documentsApi(ADMIN, [], (request) =>
      request.path === '/attachments' ? fail(503, 'FEATURE_UNAVAILABLE', 'This feature needs a database update that has not been applied yet.') : undefined,
    )
    renderApp('/amc/contracts/100')

    const panel = await documents()
    expect(await panel.findByText(/migration 0071/)).toBeInTheDocument()
    expect(panel.queryByRole('button', { name: 'Attach document' })).not.toBeInTheDocument()
  })
})
