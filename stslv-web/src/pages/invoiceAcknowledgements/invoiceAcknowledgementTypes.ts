import { useCallback, useState } from 'react'

// Finance -> Invoice Acknowledgements: the types of /api/invoice-acknowledgements (one row per INVOICE, which may
// cover several services), the column choices (remembered per user in this browser) and the file rules the page
// checks before upload. The API checks everything again.

export type AcknowledgementStatus = 'PENDING' | 'ACKNOWLEDGED'
export type ReconciliationReason = 'SAME_NUMBER' | 'CONFLICTING_ACKNOWLEDGEMENTS' | 'ZOHO_CANCELLED'

/** Reasons that stop new acknowledgement work until reconciled. ZOHO_CANCELLED is a warning only. */
export const BLOCKING_REASONS: readonly ReconciliationReason[] = ['SAME_NUMBER', 'CONFLICTING_ACKNOWLEDGEMENTS']
export const isBlocked = (item: { reconciliation: ReconciliationReason[] }) => item.reconciliation.some((reason) => BLOCKING_REASONS.includes(reason))

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
  invoiceId: string
  basis: 'ZOHO' | 'SERVICE'
  invoiceNo: string
  client: { id: string; name: string }
  contracts: { id: string; reference: string; version: number }[]
  serviceCount: number
  serviceReportNos: string[]
  invoiceDate: string | null
  zohoCancelled: boolean
  invoiceEnteredAt: string | null
  amountsVisible: boolean
  invoiceValue: string | null
  serviceValue: string | null
  status: AcknowledgementStatus
  acknowledgementId: string | null
  document: AcknowledgementDocument | null
  acknowledgedAt: string | null
  acknowledgedBy: { id: string; fullName: string } | null
  reconciliation: ReconciliationReason[]
}

export interface AcknowledgementKpis {
  total: number
  pending: number
  awaitingConfirmation: number
  acknowledged: number
  needsReconciliation: number
  invoiceValueTotal: string | null
  serviceValueTotal: string | null
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

export interface LinkedService {
  visitId: string
  contract: { id: string; reference: string; version: number }
  service: { sequenceNo: number; cycleNo: number | null; serviceCode: string | null }
  scheduledDate: string
  completedDate: string | null
  serviceReportNo: string | null
  invoiceNo: string
  basis: 'ZOHO' | 'SERVICE' | 'LINKED'
  linkedAt: string
  serviceValue: string | null
}

export interface DocumentVersion {
  attachmentId: string
  acknowledgementId: string
  invoiceNumber: string
  version: number
  isCurrent: boolean
  ofCurrentAcknowledgement: boolean
  acknowledgementStatus: AcknowledgementStatus
  originalName: string
  uploadedBy: { id: string; fullName: string }
  uploadedAt: string
}

export interface ReconciliationView {
  reasons: ReconciliationReason[]
  sameNumber: { invoiceId: string; basis: 'ZOHO' | 'SERVICE'; serviceCount: number; contracts: string[]; status: AcknowledgementStatus; hasDocument: boolean }[]
  acknowledgements: { acknowledgementId: string; status: AcknowledgementStatus; acknowledgedAt: string | null; acknowledgedBy: string | null; documentName: string | null; legacyVisitId: string | null }[]
  replacements: { zohoInvoiceId: string; invoiceNumber: string; invoiceDate: string; verified: boolean; problem: string | null }[]
}

export const STATUS_LABELS: Record<AcknowledgementStatus, string> = { PENDING: 'Pending', ACKNOWLEDGED: 'Acknowledged' }

export const RECONCILIATION_LABELS: Record<ReconciliationReason, string> = {
  SAME_NUMBER: 'Another invoice of this client has the same Invoice No.',
  CONFLICTING_ACKNOWLEDGEMENTS: 'More than one acknowledgement exists for this invoice',
  ZOHO_CANCELLED: 'Its Invoice Tracking record was cancelled',
}

export const BASIS_LABELS: Record<LinkedService['basis'], string> = {
  ZOHO: 'Invoice Tracking record',
  SERVICE: 'Invoice No. on the service',
  LINKED: 'Linked by reconciliation',
}

export const ACKNOWLEDGEMENT_NOTE =
  'Acknowledged means the client’s acknowledgement document for this invoice is on file and was confirmed. It is not payment: the Invoice No., the Paid / Unpaid reference status and every amount stay as they are.'

export const SORTS = ['invoiceNo', 'client', 'contract', 'invoiceDate', 'status', 'acknowledgedAt'] as const
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

/** "Invoice INV-100 · Alpha Towers": names the invoice in titles and screen-reader labels. */
export const subjectOf = (item: Pick<AcknowledgementItem, 'invoiceNo' | 'client'>) => `Invoice ${item.invoiceNo} · ${item.client.name}`

/** "Year 2 · Q3", or the visit number on a service generated before service codes existed. */
export function serviceLabel(service: LinkedService['service']): string {
  return service.serviceCode && service.cycleNo ? `Year ${service.cycleNo} · ${service.serviceCode}` : `No. ${service.sequenceNo}`
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export const ACK_PREFIX = 'stslev.invoice-acknowledgements'

/** The columns a user may hide, in table order; the same ids the export accepts. Invoice No., Status and Actions always stay. */
export const COLUMN_IDS = ['client', 'contract', 'invoiceDate', 'invoiceValue', 'serviceValue', 'services', 'acknowledgedAt', 'acknowledgedBy', 'uploadedBy', 'document'] as const
export type ColumnId = (typeof COLUMN_IDS)[number]

export const COLUMN_LABELS: Record<ColumnId, string> = {
  client: 'Client',
  contract: 'AMC Contract / Version',
  invoiceDate: 'Invoice Date',
  invoiceValue: 'Invoice Value (Ex VAT, OMR)',
  serviceValue: 'Service Value (Ex VAT, OMR)',
  services: 'Linked Services',
  acknowledgedAt: 'Acknowledged Date',
  acknowledgedBy: 'Acknowledged By',
  uploadedBy: 'Uploaded By',
  document: 'Document',
}

/** Columns that hold amounts: shown only when the API sent amounts (the role may view Accounts). */
export const AMOUNT_COLUMNS: readonly ColumnId[] = ['invoiceValue', 'serviceValue']

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
