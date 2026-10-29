import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { Alert, Badge, Button, Modal, SelectField, Spinner, TextAreaField, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { applyApiErrors } from '../../lib/formErrors'
import { formatDate } from '../../lib/format'
import { visitLabel, type BillableWork, type Invoice } from '../../lib/invoiceTypes'
import { formatMoney, isMoney, isZeroAmount, MONEY_MESSAGE, sameMoney, sumMoney } from '../../lib/money'

// Mirrors the API's rules so most problems are caught before a request is sent.
// The API validates again and remains the authority. Nothing is pre-filled from
// a rate or a guess: the invoice details are typed from the Zoho invoice.
const invoiceSchema = z.object({
  clientId: z.string().min(1, 'Select a client.'),
  invoiceNumber: z.string().trim().min(1, 'Invoice number is required.').max(50, 'Invoice number must be at most 50 characters.'),
  invoiceDate: z.string().min(1, 'Invoice date is required.'),
  amountExclVat: z
    .string()
    .trim()
    .min(1, 'Amount excluding VAT is required.')
    .refine(isMoney, MONEY_MESSAGE)
    .refine((value) => !isZeroAmount(value), 'Amount excluding VAT must be greater than zero.'),
  vatAmount: z.string().trim().min(1, 'VAT amount is required. Enter 0 if the invoice has no VAT.').refine(isMoney, MONEY_MESSAGE),
  sourceReference: z.string().trim().max(200, 'Zoho reference must be at most 200 characters.'),
  notes: z.string().trim().max(2000, 'Notes must be at most 2000 characters.'),
})

type InvoiceForm = z.infer<typeof invoiceSchema>
const FIELDS = ['clientId', 'invoiceNumber', 'invoiceDate', 'amountExclVat', 'vatAmount', 'sourceReference', 'notes'] as const

/** Opens the form for one client with one piece of work already ticked. */
export interface InvoicePreset {
  client: { id: string; name: string }
  /** "visit:<id>" or "project:<id>". */
  key: string
  /** The amount offered for it; empty when none can be offered safely. */
  amount: string
}

interface InvoiceFormModalProps {
  /** The invoice to edit, or null to record a new one. */
  invoice: Invoice | null
  preset?: InvoicePreset | undefined
  onClose: () => void
  onSaved: (invoice: Invoice) => void
}

interface WorkRow {
  key: string
  title: string
  detail: string
  /** Shown when an invoice already covers the work. */
  invoiced: string | null
  /** The amount offered when the row is ticked; empty when none can be offered safely. */
  suggested: string
}

/**
 * The work an invoice can cover: the client's completed visits and projects,
 * plus whatever the invoice being edited already covers (so an allocation the
 * user may not look up is never dropped).
 */
function workRows(work: BillableWork | undefined, invoice: Invoice | null): WorkRow[] {
  const rows: WorkRow[] = []

  for (const visit of work?.amcVisits?.items ?? []) {
    rows.push({
      key: `visit:${visit.id}`,
      title: `AMC ${visitLabel(visit, formatDate)}`,
      detail: `Completed ${formatDate(visit.completedDate)} · Visit amount ${formatMoney(visit.visitAmount)} (as entered)`,
      invoiced: visit.invoiceEligibility === 'INVOICED' ? `Invoiced ${formatMoney(visit.invoicedAmount)}` : null,
      // Not offered: whether a visit amount includes VAT is not confirmed.
      suggested: '',
    })
  }
  for (const project of work?.projects?.items ?? []) {
    rows.push({
      key: `project:${project.id}`,
      title: `${project.jobNumber} — ${project.description}`,
      detail: `Completed ${formatDate(project.completedDate)} · Job value ${formatMoney(project.jobValue)} excl. VAT · Not yet invoiced ${formatMoney(project.uninvoicedValue)}`,
      invoiced: isZeroAmount(project.invoicedValue) ? null : `Invoiced ${formatMoney(project.invoicedValue)}`,
      suggested: isZeroAmount(project.uninvoicedValue) ? '' : project.uninvoicedValue,
    })
  }
  for (const allocation of invoice?.allocations ?? []) {
    const key = allocation.amcVisit ? `visit:${allocation.amcVisit.id}` : `project:${allocation.project?.id}`

    if (!rows.some((row) => row.key === key)) {
      rows.push({
        key,
        title: allocation.amcVisit
          ? `AMC ${visitLabel(allocation.amcVisit, formatDate)}`
          : `${allocation.project?.jobNumber} — ${allocation.project?.description}`,
        detail: 'Covered by this invoice',
        invoiced: null,
        suggested: '',
      })
    }
  }

  return rows
}

const initialAmounts = (invoice: Invoice | null, preset: InvoicePreset | undefined): Record<string, string> =>
  invoice
    ? Object.fromEntries(
        invoice.allocations.map((allocation) => [
          allocation.amcVisit ? `visit:${allocation.amcVisit.id}` : `project:${allocation.project?.id}`,
          allocation.amount,
        ]),
      )
    : preset
      ? { [preset.key]: preset.amount }
      : {}

export function InvoiceFormModal({ invoice, preset, onClose, onSaved }: InvoiceFormModalProps) {
  const queryClient = useQueryClient()
  const workHeadingId = useId()
  const fixedClient = invoice?.client ?? preset?.client ?? null
  const [failure, setFailure] = useState<string | null>(null)
  const [allocationErrors, setAllocationErrors] = useState<string[]>([])
  // Ticked work, by key, with the amount typed for it.
  const [amounts, setAmounts] = useState<Record<string, string>>(() => initialAmounts(invoice, preset))
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors },
  } = useForm<InvoiceForm>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      clientId: fixedClient?.id ?? '',
      invoiceNumber: invoice?.invoiceNumber ?? '',
      invoiceDate: invoice?.invoiceDate ?? '',
      amountExclVat: invoice?.amountExclVat ?? '',
      vatAmount: invoice?.vatAmount ?? '',
      sourceReference: invoice?.sourceReference ?? '',
      notes: invoice?.notes ?? '',
    },
  })
  const clientId = useWatch({ control, name: 'clientId' })
  const amountExclVat = useWatch({ control, name: 'amountExclVat' }).trim()
  const vatAmount = useWatch({ control, name: 'vatAmount' }).trim()

  // A new invoice is offered the clients that have completed work waiting.
  const pending = useQuery({
    queryKey: ['invoices', 'billable', 'pending'],
    queryFn: () => api.get<BillableWork>('/invoices/billable'),
    enabled: fixedClient === null,
  })
  const work = useQuery({
    queryKey: ['invoices', 'billable', 'client', clientId],
    queryFn: () => api.get<BillableWork>(`/invoices/billable?clientId=${clientId}&includeInvoiced=true`),
    enabled: clientId !== '',
  })

  const clients = new Map<string, string>()

  for (const item of [...(pending.data?.amcVisits?.items ?? []), ...(pending.data?.projects?.items ?? [])]) {
    clients.set(item.client.id, item.client.name)
  }

  const rows = workRows(work.data, invoice)
  const selected = rows.filter((row) => row.key in amounts)
  const typed = selected.map((row) => (amounts[row.key] ?? '').trim())
  const allTyped = selected.length > 0 && typed.every((value) => isMoney(value) && !isZeroAmount(value))
  const allocated = allTyped ? sumMoney(typed) : null
  const reconciles = allocated !== null && isMoney(amountExclVat) && sameMoney(allocated, amountExclVat)
  const total = isMoney(amountExclVat) && isMoney(vatAmount) ? sumMoney([amountExclVat, vatAmount]) : null

  const save = useMutation({
    mutationFn: (values: InvoiceForm) => {
      const body = {
        ...values,
        allocations: selected.map((row) => {
          const [kind, id] = row.key.split(':')
          const amount = (amounts[row.key] ?? '').trim()

          return kind === 'visit' ? { amcVisitId: id, amount } : { projectId: id, amount }
        }),
      }

      return invoice ? api.patch<Invoice>(`/invoices/${invoice.id}`, body) : api.post<Invoice>('/invoices', body)
    },
    onSuccess: async (saved) => {
      // Invoice states of visits and projects are derived from invoices, so they are read again too.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['invoices'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['amc'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      onSaved(saved)
    },
    onError: (error) => {
      const onAllocations = error instanceof ApiError ? error.details.filter((detail) => detail.field.startsWith('allocations')) : []

      setAllocationErrors(onAllocations.map((detail) => detail.message))
      setFailure(onAllocations.length > 0 ? null : applyApiErrors(error, FIELDS, setError))
    },
  })

  const onSubmit = handleSubmit((values) => {
    setFailure(null)

    if (selected.length === 0) {
      setAllocationErrors(['Tick at least one visit or project that this invoice covers.'])
      return
    }
    if (!allTyped) {
      setAllocationErrors(['Enter an amount above zero, with at most 3 decimal places, for every visit or project that is ticked.'])
      return
    }
    if (!reconciles) {
      setAllocationErrors([
        `The allocations add up to ${formatMoney(allocated)}, but the amount excluding VAT is ${formatMoney(values.amountExclVat.trim())}. They must be equal.`,
      ])
      return
    }

    setAllocationErrors([])
    save.mutate(values)
  })

  const toggle = (row: WorkRow, checked: boolean) =>
    setAmounts((current) => {
      const next = { ...current }

      if (checked) {
        next[row.key] = row.suggested
      } else {
        delete next[row.key]
      }

      return next
    })

  const title = invoice ? `Edit Invoice ${invoice.invoiceNumber}` : 'Record Invoice'
  const clientField = register('clientId', { onChange: () => setAmounts({}) })

  return (
    <Modal
      title={title}
      onClose={onClose}
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Close
          </Button>
          <Button type="submit" form="invoice-form" loading={save.isPending}>
            {invoice ? 'Save changes' : 'Record invoice'}
          </Button>
        </>
      }
    >
      <form id="invoice-form" onSubmit={onSubmit} noValidate className="space-y-4">
        {failure && <Alert>{failure}</Alert>}
        <p className="text-sm text-slate-600">
          Enter the details exactly as they appear on the invoice raised in Zoho. Nothing is calculated for you except the total.
        </p>

        {fixedClient ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <span className="font-medium">Client: </span>
            {fixedClient.name}
          </div>
        ) : pending.isError ? (
          <Alert>{errorMessage(pending.error)}</Alert>
        ) : !pending.data ? (
          <Spinner size="sm" label="Loading clients" />
        ) : clients.size === 0 ? (
          // Work the role may not see is not "no work": say which part is hidden instead.
          <Alert tone="info">
            {pending.data.amcVisits === null && pending.data.projects === null
              ? 'Your role cannot see AMC visits or projects, so no completed work can be listed here. Ask an administrator if you need to record invoices.'
              : pending.data.amcVisits === null
                ? 'No completed project work is waiting for an invoice. AMC visits are not listed: your role cannot view the AMC Schedule.'
                : pending.data.projects === null
                  ? 'No completed AMC visit is waiting for an invoice. Projects are not listed: your role cannot view Projects.'
                  : 'No completed work is waiting for an invoice, so there is nothing to record an invoice against.'}
          </Alert>
        ) : (
          <SelectField
            label="Client"
            required
            hint="Clients with completed work waiting for an invoice."
            error={errors.clientId?.message}
            {...clientField}
          >
            <option value="">Select a client…</option>
            {[...clients].sort(([, a], [, b]) => a.localeCompare(b, undefined, { sensitivity: 'base' })).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </SelectField>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Invoice number" required hint="As shown on the Zoho invoice." error={errors.invoiceNumber?.message} {...register('invoiceNumber')} />
          <TextField label="Invoice date" type="date" required error={errors.invoiceDate?.message} {...register('invoiceDate')} />
          <TextField
            label="Amount excluding VAT"
            inputMode="decimal"
            required
            hint="Up to 3 decimal places."
            error={errors.amountExclVat?.message}
            {...register('amountExclVat')}
          />
          <TextField
            label="VAT amount"
            inputMode="decimal"
            required
            hint="As shown on the invoice. Enter 0 if there is none."
            error={errors.vatAmount?.message}
            {...register('vatAmount')}
          />
        </div>
        <p className="text-sm text-slate-700">
          Total including VAT:{' '}
          <strong data-testid="invoice-form-total" className="tabular-nums">
            {formatMoney(total)}
          </strong>
        </p>

        <section aria-labelledby={workHeadingId} className="rounded-lg border border-slate-200">
          <h3 id={workHeadingId} className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-900">
            What this invoice covers
          </h3>
          <div className="space-y-3 px-4 py-3">
            {clientId === '' && <p className="text-sm text-slate-500">Select a client to see its completed work.</p>}
            {clientId !== '' && work.isPending && <Spinner size="sm" label="Loading completed work" />}
            {work.isError && <Alert>{errorMessage(work.error)}</Alert>}
            {work.data && rows.length === 0 && <p className="text-sm text-slate-500">This client has no completed work that can be invoiced.</p>}
            {work.data && (work.data.amcVisits === null || work.data.projects === null) && (
              <p className="text-xs text-slate-500">
                {work.data.amcVisits === null && 'AMC visits are listed for roles that may view the AMC Schedule. '}
                {work.data.projects === null && 'Projects are listed for roles that may view Projects.'}
              </p>
            )}
            {(work.data || invoice) &&
              rows.map((row) => {
                const checked = row.key in amounts

                return (
                  <div key={row.key} className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3 last:border-b-0 last:pb-0">
                    <label className="flex min-w-0 flex-1 items-start gap-3 text-sm text-slate-800">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => toggle(row, event.target.checked)}
                        className="mt-1 h-4 w-4 rounded border-slate-300"
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{row.title}</span>
                        {row.invoiced && (
                          <>
                            {' '}
                            <Badge tone="blue">{row.invoiced}</Badge>
                          </>
                        )}
                        <span className="block text-xs text-slate-500">{row.detail}</span>
                      </span>
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`Allocation for ${row.title}`}
                      placeholder="Amount excl. VAT"
                      disabled={!checked}
                      value={amounts[row.key] ?? ''}
                      onChange={(event) => setAmounts((current) => ({ ...current, [row.key]: event.target.value }))}
                      className="block w-40 rounded-lg border border-slate-300 bg-white px-3 py-2 text-right text-sm tabular-nums shadow-sm placeholder:text-slate-400 disabled:bg-slate-100"
                    />
                  </div>
                )
              })}
          </div>
          <p className="border-t border-slate-200 px-4 py-2.5 text-sm text-slate-700" data-testid="invoice-form-allocated">
            Allocated: <strong className="tabular-nums">{formatMoney(allocated)}</strong>
            {allocated !== null && isMoney(amountExclVat) && (
              <span className={reconciles ? 'text-green-700' : 'text-red-700'}>
                {' '}
                — {reconciles ? 'equal to the amount excluding VAT.' : `must equal the amount excluding VAT (${formatMoney(amountExclVat)}).`}
              </span>
            )}
          </p>
        </section>
        {allocationErrors.length > 0 && (
          <Alert>
            {allocationErrors.map((message) => (
              <span key={message} className="block">
                {message}
              </span>
            ))}
          </Alert>
        )}

        <TextField
          label="Zoho reference"
          hint="Optional. Any further reference from Zoho, if you keep one."
          error={errors.sourceReference?.message}
          {...register('sourceReference')}
        />
        <TextAreaField label="Notes" rows={2} error={errors.notes?.message} {...register('notes')} />
      </form>
    </Modal>
  )
}
