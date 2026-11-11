import { useState } from 'react'
import { download, errorMessage, saveFile } from '../../lib/api'
import { cx } from '../../lib/format'

/**
 * The invoice acknowledgement of ONE service (2026-11-11), as the service-level APIs return it (Master AMC Status,
 * Service Status, Contract 360). Read from Invoice Acknowledgements; it is not the service's execution status and not
 * payment. Absent (null) when the user may not view Invoice Acknowledgements.
 */
export interface ServiceAcknowledgement {
  state: 'NOT_APPLICABLE' | 'PENDING' | 'AWAITING_CONFIRMATION' | 'ACKNOWLEDGED'
  acknowledged: 'YES' | 'NO' | 'NOT_APPLICABLE'
  invoiceId: string | null
  documentAvailable: boolean
  acknowledgedAt: string | null
  needsReconciliation: boolean
}

/** The Yes / No / Not Applicable words, shown with the colour (never colour alone). */
const ACKNOWLEDGED_LABELS: Record<ServiceAcknowledgement['acknowledged'], string> = {
  YES: 'Yes',
  NO: 'No',
  NOT_APPLICABLE: 'Not Applicable',
}

const TONE: Record<ServiceAcknowledgement['acknowledged'], string> = {
  // Green: the acknowledgement document is on file and confirmed for this service's invoice.
  YES: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  // Red: the service has an Invoice No. but its acknowledgement is missing or not yet confirmed.
  NO: 'bg-red-50 text-red-800 ring-red-300',
  // Neutral: no invoice, so nothing to acknowledge.
  NOT_APPLICABLE: 'bg-slate-100 text-slate-600 ring-slate-300',
}

function detailOf(acknowledgement: ServiceAcknowledgement): string | null {
  if (acknowledgement.needsReconciliation) return 'Needs reconciliation in Invoice Acknowledgements'
  if (acknowledgement.state === 'AWAITING_CONFIRMATION') return 'Document uploaded, awaiting confirmation'
  if (acknowledgement.state === 'PENDING') return 'Acknowledgement document missing'
  if (acknowledgement.state === 'NOT_APPLICABLE') return 'No invoice recorded'
  return null
}

/** The full sentence for screen readers and the hover title. */
function acknowledgementDescription(acknowledgement: ServiceAcknowledgement): string {
  const detail = detailOf(acknowledgement)

  return `Invoice acknowledged: ${ACKNOWLEDGED_LABELS[acknowledgement.acknowledged]}${detail ? `. ${detail}` : ''}`
}

/**
 * The indicator: a labelled pill (green Yes / red No / neutral Not Applicable), a short reason, and, when a document is
 * on file, a Download button. The file comes through the Invoice Acknowledgements API with the user's own permission;
 * no storage path or public link reaches the browser.
 */
export function ServiceAcknowledgementIndicator({ acknowledgement, compact = false }: { acknowledgement: ServiceAcknowledgement; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const detail = detailOf(acknowledgement)
  const description = acknowledgementDescription(acknowledgement)
  const invoiceId = acknowledgement.invoiceId

  const fetchDocument = async () => {
    if (!invoiceId) return
    setBusy(true)
    setFailure(null)
    try {
      saveFile(await download(`/invoice-acknowledgements/${invoiceId}/document`), 'invoice-acknowledgement')
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="block" data-acknowledged={acknowledgement.acknowledged} data-acknowledgement-state={acknowledgement.state}>
      <span
        title={description}
        className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset', TONE[acknowledgement.acknowledged])}
      >
        {acknowledgement.acknowledged === 'YES' ? (
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="M4.5 10.5l3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : acknowledgement.acknowledged === 'NO' ? (
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="M10 5.5v5.5M10 14.2v.3" strokeLinecap="round" />
          </svg>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" aria-hidden="true" />
        )}
        <span className="sr-only">Invoice acknowledged: </span>
        {ACKNOWLEDGED_LABELS[acknowledgement.acknowledged]}
      </span>
      {!compact && detail && <span className="mt-1 block text-xs text-slate-600">{detail}</span>}
      {acknowledgement.documentAvailable && invoiceId && (
        <button
          type="button"
          onClick={() => void fetchDocument()}
          disabled={busy}
          className="mt-1 block text-xs font-semibold text-[#1479BD] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1479BD] disabled:opacity-60"
          aria-label={`Download the acknowledgement document. ${description}`}
        >
          {busy ? 'Downloading…' : 'Download document'}
        </button>
      )}
      {failure && (
        <span role="alert" className="mt-1 block text-xs text-red-700">
          {failure}
        </span>
      )}
    </span>
  )
}
