import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api, errorMessage } from '../../lib/api'
import { cx } from '../../lib/format'
import { refreshOperationalData } from '../../lib/refreshOperationalData'

/** Shown wherever Paid or Unpaid appears, so nobody reads it as a bank-verified payment. */
export const PAID_STATUS_NOTE = 'Paid means a manual Invoice No. is entered on the service. It is a reference status and does not verify that money was received.'

/** Why the Invoice No. of a service that is not completed cannot be entered. */
export const COMPLETE_FIRST_NOTE = 'Complete the service before entering an invoice number.'

export function PaymentBadge({ invoiceNo }: { invoiceNo: string | null }) {
  return (
    <span
      title={PAID_STATUS_NOTE}
      className={cx(
        'inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
        invoiceNo ? 'bg-emerald-100 text-emerald-800 ring-emerald-200' : 'bg-sky-100 text-[#0b3b66] ring-sky-200',
      )}
    >
      {invoiceNo ? 'Paid' : 'Unpaid'}
    </span>
  )
}

interface Props {
  visitId: string
  invoiceNo: string | null
  updatedAt: string
  canEdit: boolean
  /**
   * The persisted visit status is Completed. Only then may a number be entered or changed; a number
   * already on a service that is not completed stays visible and may still be cleared. The API
   * enforces the same rule from the stored status.
   */
  completed: boolean
  /** Names the service for assistive technology, e.g. "AMC-0007 Q2". */
  label: string
}

/**
 * The manual Invoice No. of one service: type a number and press OK for Paid; clear it and press OK
 * for Unpaid. Nothing else is asked for and no invoice is generated. A person without the permission
 * sees the number and the status only; the API enforces this as well. A number is entered only on a
 * completed service.
 */
export function ManualInvoiceField({ visitId, invoiceNo, updatedAt, canEdit, completed, label }: Props) {
  const queryClient = useQueryClient()
  const saved = invoiceNo ?? ''
  const [draft, setDraft] = useState(saved)
  const [base, setBase] = useState(saved)
  const [failure, setFailure] = useState<string | null>(null)

  // A newer value from the server replaces the draft only if the user has not typed over it.
  if (saved !== base) {
    setBase(saved)
    if (draft === base) setDraft(saved)
  }

  const save = useMutation({
    mutationFn: (value: string) => api.patch(`/amc/visits/${visitId}/manual-invoice`, { invoiceNo: value === '' ? null : value, expectedUpdatedAt: updatedAt }),
    onSuccess: async () => {
      setFailure(null)
      await refreshOperationalData(queryClient)
    },
    onError: (error) => setFailure(errorMessage(error)),
  })

  if (!canEdit) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        {invoiceNo && <span className="font-mono text-sm font-semibold text-slate-900">{invoiceNo}</span>}
        <PaymentBadge invoiceNo={invoiceNo} />
      </span>
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (completed && draft.trim() !== saved) save.mutate(draft.trim())
  }
  const noteId = `invoice-note-${visitId}`

  return (
    <form onSubmit={submit} className="min-w-[13rem]" noValidate>
      <span className="flex items-center gap-1.5">
        <input
          type="text"
          value={completed ? draft : saved}
          maxLength={50}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`Invoice No. for ${label}`}
          aria-describedby={completed ? undefined : noteId}
          placeholder="Invoice No."
          // A number already saved stays readable (read-only); an empty field is disabled.
          readOnly={!completed && saved !== ''}
          disabled={!completed && saved === ''}
          className="w-28 rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-sm text-slate-900 placeholder:font-sans placeholder:text-slate-500 read-only:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!completed || save.isPending || draft.trim() === saved}
          aria-label={`Save Invoice No. for ${label}`}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-[#0b3b66] hover:border-[#1479BD] disabled:opacity-40"
        >
          OK
        </button>
        {!completed && saved !== '' && (
          // Clearing returns the service to Unpaid and stays allowed whatever the service status.
          <button
            type="button"
            onClick={() => save.mutate('')}
            disabled={save.isPending}
            aria-label={`Clear Invoice No. for ${label}`}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-[#0b3b66] hover:border-[#1479BD] disabled:opacity-40"
          >
            Clear
          </button>
        )}
        <PaymentBadge invoiceNo={invoiceNo} />
      </span>
      {!completed && (
        <span id={noteId} className="mt-1 block whitespace-normal text-xs text-slate-500">
          {COMPLETE_FIRST_NOTE}
        </span>
      )}
      {failure && (
        <span role="alert" className="mt-1 block whitespace-normal text-xs font-medium text-red-700">
          {failure}
        </span>
      )}
    </form>
  )
}
