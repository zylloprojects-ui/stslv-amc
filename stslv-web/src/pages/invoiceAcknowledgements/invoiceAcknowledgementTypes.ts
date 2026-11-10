import { useCallback, useState } from 'react'

// Finance -> Invoice Acknowledgements: the types of /api/invoice-acknowledgements, the column choices (remembered per
// user in this browser) and the file rules the page checks before upload. The API checks everything again.

export type AcknowledgementStatus = 'PENDING' | 'ACKNOWLEDGED'

export interface AcknowledgementDocument {
  attachmentId: string
  version: number
  originalName: string
  mimeType: string
  sizeBytes: number
  uploadedBy: { id: string; fullName: string }
  uploadedAt: string
}

export interface AcknowledgementItem {
  visitId: string
  acknowledgementId: string | null
  reference: string
  contract: { id: string; version: number }
  client: { id: string; name: string }
  system: { description: string; typeName: string | null }
  service: { sequenceNo: number; cycleNo: number | null; serviceCode: string | null }
  scheduledDate: string
  completedDate: string | null
  serviceReportNo: string | null
  invoiceNo: string
  invoiceEnteredAt: string | null
  invoiceDate: string | null
  amountsVisible: boolean
  serviceValue: string | null
  invoiceValue: string | null
  status: AcknowledgementStatus
  document: AcknowledgementDocument | null
  acknowledgedAt: string | null
  acknowledgedBy: { id: string; fullName: string } | null
}

export interface AcknowledgementKpis {
  total: number
  pending: number
  awaitingConfirmation: number
  acknowledged: number
  serviceValueTotal: string | null
  invoiceValueTotal: string | null
}

export interface AcknowledgementList {
  items: AcknowledgementItem[]
  total: number
  page: number
  pageSize: number
  kpis: AcknowledgementKpis
}

export interface AcknowledgementOptions {
  clients: { id: string; name: string }[]
  contracts: { id: string; reference: string; client: string; system: string }[]
  limits: { maxMb: number; types: string }
}

export interface DocumentVersion {
  attachmentId: string
  invoiceNumber: string
  version: number
  isCurrent: boolean
  originalName: string
  uploadedBy: { id: string; fullName: string }
  uploadedAt: string
}

export const STATUS_LABELS: Record<AcknowledgementStatus, string> = { PENDING: 'Pending', ACKNOWLEDGED: 'Acknowledged' }

/** Shown on the page and in Help: an acknowledgement is not a payment. */
export const ACKNOWLEDGEMENT_NOTE =
  'Acknowledged means the client’s acknowledgement document for this invoice is on file and was confirmed. It is not payment: the Invoice No., the Paid / Unpaid reference status and every amount stay as they are.'

export const SORTS = ['reference', 'client', 'invoiceNo', 'invoiceDate', 'status', 'acknowledgedAt'] as const
export type Sort = (typeof SORTS)[number]

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const DOCUMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg'
const EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg']
const MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg']

/** Why a chosen file cannot be an acknowledgement document, or null. An empty browser-stated type is allowed: the server checks the content. */
export function documentFileProblem(file: File, maxMb: number): string | null {
  const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : ''

  if (!EXTENSIONS.includes(extension)) return 'Only PDF, PNG and JPEG files can be uploaded as an acknowledgement.'
  if (file.type !== '' && !MIME_TYPES.includes(file.type)) return 'This file type is not accepted. Choose a PDF, PNG or JPEG file.'
  if (file.size === 0) return 'The chosen file is empty. Choose another file.'
  if (file.size > maxMb * 1024 * 1024) return `Acknowledgement documents can be at most ${maxMb} MB.`
  return null
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** "STS-AMC-001 (V2) · Invoice INV-100": names the invoice in titles and screen-reader labels. */
export const subjectOf = (item: AcknowledgementItem) => `${item.reference} · Invoice ${item.invoiceNo}`

/** "Year 2 · Q3", or the visit number on a service generated before service codes existed. */
export function serviceLabel(service: AcknowledgementItem['service']): string {
  return service.serviceCode && service.cycleNo ? `Year ${service.cycleNo} · ${service.serviceCode}` : `No. ${service.sequenceNo}`
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export const ACK_PREFIX = 'stslev.invoice-acknowledgements'

/** The columns a user may hide, in table order; the same ids the export accepts. AMC Contract, Invoice No., Status and Actions always stay. */
export const COLUMN_IDS = ['client', 'service', 'serviceReportNo', 'invoiceDate', 'serviceValue', 'invoiceValue', 'acknowledgedAt', 'uploadedBy', 'document'] as const
export type ColumnId = (typeof COLUMN_IDS)[number]

export const COLUMN_LABELS: Record<ColumnId, string> = {
  client: 'Client',
  service: 'Service',
  serviceReportNo: 'Service Report No.',
  invoiceDate: 'Invoice Date',
  serviceValue: 'Service Value (Ex VAT, OMR)',
  invoiceValue: 'Invoice Value (Ex VAT, OMR)',
  acknowledgedAt: 'Acknowledged Date',
  uploadedBy: 'Uploaded By',
  document: 'Document',
}

/** Columns that hold amounts: shown only when the API sent amounts (the role may view Accounts). */
export const AMOUNT_COLUMNS: readonly ColumnId[] = ['serviceValue', 'invoiceValue']

function load(key: string): ReadonlySet<ColumnId> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return new Set(Array.isArray(saved) ? saved.filter((id): id is ColumnId => COLUMN_IDS.includes(id as ColumnId)) : [])
  } catch {
    return new Set()
  }
}

/** The columns this user has hidden, remembered in this browser. Read again when the signed-in user changes. */
export function useHiddenColumns(userId: string): [ReadonlySet<ColumnId>, (hidden: ReadonlySet<ColumnId>) => void] {
  const key = `${ACK_PREFIX}.hidden-columns.${userId}`
  const [state, setState] = useState(() => ({ key, hidden: load(key) }))

  if (state.key !== key) setState({ key, hidden: load(key) })

  const setHidden = useCallback(
    (next: ReadonlySet<ColumnId>) => {
      setState({ key, hidden: next })
      try {
        if (next.size > 0) localStorage.setItem(key, JSON.stringify([...next]))
        else localStorage.removeItem(key)
      } catch {
        // Storage may be blocked; the choice then lasts for this visit only.
      }
    },
    [key],
  )

  return [state.key === key ? state.hidden : load(key), setHidden]
}
