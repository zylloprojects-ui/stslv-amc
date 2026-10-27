import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { LinkedContracts } from '../../components/LinkedContracts'
import { DetailRow, LoadError, Money, OrDash } from '../../components/records'
import { RecordHistory } from '../../components/RecordHistory'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, ConfirmDialog, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { formatCount, formatDate, formatDateTime } from '../../lib/format'
import type { PagedInvoices } from '../../lib/invoiceTypes'
import { formatMoney } from '../../lib/money'
import { CLIENT_STATUS_LABELS, CLIENT_TYPE_LABELS, type Client, type ClientFeatures, type ClientSummary, type ClientType } from '../../lib/types'
import { VisitStatusPill } from '../amc/components'
import type { VisitList } from '../amc/types'
import { InvoiceStatusBadge } from '../invoices/InvoicesTable'
import { ClientFormModal } from './ClientFormModal'
import { ClientStatusBadge } from './ClientStatusBadge'

const ACTION_LABELS: Record<string, string> = {
  'client.created': 'Client added',
  'client.updated': 'Client updated',
  'client.deactivated': 'Client disabled',
  'client.reactivated': 'Client enabled',
  'client.contracts_exported': 'AMC contracts exported',
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Client name',
  contactPerson: 'Contact person',
  email: 'Email',
  phone: 'Phone',
  address: 'Address',
  notes: 'Remarks',
  clientType: 'Client type',
  vatNumber: 'VAT number',
}

// Visits still to be done: the same statuses the schedule counts as open.
const OPEN_VISIT_STATUSES = 'SCHEDULED,IN_PROGRESS,POSTPONED'
const LIST_LIMIT = 10

function Section({ id, title, actions, children }: { id: string; title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <section aria-labelledby={id}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <h2 id={id} className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          {actions}
        </div>
        {children}
      </section>
    </Card>
  )
}

/**
 * One Client 360 figure. `value` null shows "Not available" with the reason in
 * `hint`, so a figure the system does not have is never shown as a zero.
 */
function Metric({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode | null; hint?: ReactNode; tone?: 'default' | 'warn' }) {
  const unavailable = value === null

  return (
    <div className={`rounded-xl border bg-white p-4 shadow-sm ${unavailable ? 'border-dashed border-slate-200' : tone === 'warn' ? 'border-amber-200' : 'border-slate-200'}`}>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className={`mt-1 text-xl font-bold tabular-nums ${unavailable ? 'text-base font-semibold text-slate-400' : 'text-[#0b3b66]'}`}>{unavailable ? 'Not available' : value}</dd>
      {hint && <dd className={`mt-1 text-xs ${tone === 'warn' && !unavailable ? 'text-amber-700' : 'text-slate-500'}`}>{hint}</dd>}
    </div>
  )
}

const NO_ACCESS = (module: string) => `Your role does not include ${module}.`

function SummaryStrip({ summary }: { summary: ClientSummary }) {
  const { contracts, visits, invoices } = summary

  return (
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric
        label="Total AMC contracts"
        value={contracts ? formatCount(contracts.total) : null}
        hint={contracts ? `${contracts.draft} draft · ${contracts.expired} expired · ${contracts.cancelled} cancelled` : NO_ACCESS('AMC contracts')}
      />
      <Metric label="Active AMC contracts" value={contracts ? formatCount(contracts.active) : null} hint={contracts ? undefined : NO_ACCESS('AMC contracts')} />
      <Metric
        label="Active AMC value"
        value={contracts ? formatMoney(contracts.activeValue) : null}
        hint={contracts ? `All contracts except cancelled: ${formatMoney(contracts.nonCancelledValue)}` : NO_ACCESS('AMC contracts')}
      />
      <Metric
        label="Final credit (active contracts)"
        value={contracts ? formatMoney(contracts.finalCreditTotal) : null}
        hint={contracts ? `Entered on ${contracts.finalCreditRecorded} of ${contracts.active} active ${contracts.active === 1 ? 'contract' : 'contracts'}` : NO_ACCESS('AMC contracts')}
      />
      <Metric
        label="Upcoming visits"
        value={visits ? formatCount(visits.upcoming) : null}
        hint={visits ? (visits.nextVisitDate ? `Next on ${formatDate(visits.nextVisitDate)}` : 'None scheduled') : NO_ACCESS('the AMC schedule')}
      />
      <Metric
        label="Overdue visits"
        value={visits ? formatCount(visits.overdue) : null}
        tone={visits && visits.overdue > 0 ? 'warn' : 'default'}
        hint={visits ? `${formatCount(visits.completed)} completed · ${formatCount(visits.readyForInvoice)} ready for invoice` : NO_ACCESS('the AMC schedule')}
      />
      <Metric
        label="Invoices issued"
        value={invoices ? formatCount(invoices.issued) : null}
        hint={
          invoices
            ? `${formatMoney(invoices.issuedTotal)} incl. VAT${invoices.lastInvoiceDate ? ` · last ${formatDate(invoices.lastInvoiceDate)}` : ''}${invoices.cancelled > 0 ? ` · ${invoices.cancelled} cancelled` : ''}`
            : NO_ACCESS('invoices')
        }
      />
      <Metric label="Paid / unpaid invoices" value={null} hint="Payments are not recorded in STSLV AMC." />
    </dl>
  )
}

function Renewals({ renewals }: { renewals: NonNullable<ClientSummary['renewals']> }) {
  if (renewals.items.length === 0) {
    return <p className="px-6 py-4 text-sm text-slate-600">No active contract ends within the next {renewals.windowDays} days.</p>
  }

  return (
    <>
      <ul className="divide-y divide-slate-100">
        {renewals.items.map((contract) => (
          <li key={contract.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3">
            <div className="min-w-0">
              <Link to={`/amc/contracts/${contract.id}`} className="font-medium text-blue-700 hover:underline">
                {contract.systemDescription}
              </Link>
              <span className="block text-xs text-slate-500">
                Valid {formatDate(contract.validFrom)} – {formatDate(contract.validTo)} · <Money value={contract.contractValue} />
              </span>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${contract.daysLeft < 0 ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>
              {contract.daysLeft < 0 ? `Ended ${-contract.daysLeft} ${contract.daysLeft === -1 ? 'day' : 'days'} ago` : contract.daysLeft === 0 ? 'Ends today' : `Ends in ${contract.daysLeft} ${contract.daysLeft === 1 ? 'day' : 'days'}`}
            </span>
          </li>
        ))}
      </ul>
      {renewals.total > renewals.items.length && (
        <p className="border-t border-slate-200 px-6 py-3 text-sm text-slate-600">
          Showing {renewals.items.length} of {renewals.total}. The full list is in AMC Contracts.
        </p>
      )}
    </>
  )
}

function UpcomingVisits({ clientId, from }: { clientId: string; from: string }) {
  const params = new URLSearchParams({ clientId, from, status: OPEN_VISIT_STATUSES, pageSize: String(LIST_LIMIT) })
  const visits = useQuery({ queryKey: ['amc', 'visits', 'client-upcoming', clientId, from], queryFn: () => api.get<VisitList>(`/amc/visits?${params.toString()}`) })

  if (visits.isPending) return <Spinner size="sm" label="Loading visits" />
  if (visits.isError) return <LoadError error={visits.error} onRetry={() => void visits.refetch()} />
  if (visits.data.items.length === 0) return <EmptyState title="No upcoming visits" />

  return (
    <>
      <div className={TABLE.wrapper}>
        <table className={TABLE.table}>
          <caption className="sr-only">Upcoming AMC visits</caption>
          <thead>
            <tr>
              <th scope="col" className={TABLE.th}>
                Scheduled date
              </th>
              <th scope="col" className={TABLE.th}>
                System
              </th>
              <th scope="col" className={TABLE.th}>
                Visit
              </th>
              <th scope="col" className={TABLE.th}>
                Assigned to
              </th>
              <th scope="col" className={TABLE.th}>
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visits.data.items.map((visit) => (
              <tr key={visit.id}>
                <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(visit.scheduledDate)}</td>
                <td className={TABLE.td}>
                  <Link to={`/amc/contracts/${visit.contract.id}`} className="font-medium text-blue-700 hover:underline">
                    {visit.contract.systemDescription}
                  </Link>
                </td>
                <td className={`${TABLE.td} whitespace-nowrap tabular-nums`}>No. {visit.sequenceNo}</td>
                <td className={TABLE.td}>
                  <OrDash value={visit.assignedTo} />
                </td>
                <td className={TABLE.td}>
                  <VisitStatusPill status={visit.status} overdue={visit.isOverdue} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visits.data.total > visits.data.items.length && (
        <p className="border-t border-slate-200 px-6 py-3 text-sm text-slate-600">
          Showing the next {visits.data.items.length} of {visits.data.total} upcoming visits. The full list is in the AMC Schedule.
        </p>
      )}
    </>
  )
}

function RelatedInvoices({ clientId }: { clientId: string }) {
  const invoices = useQuery({
    queryKey: ['invoices', 'client', clientId],
    queryFn: () => api.get<PagedInvoices>(`/invoices?${new URLSearchParams({ clientId, pageSize: String(LIST_LIMIT) }).toString()}`),
  })

  if (invoices.isPending) return <Spinner size="sm" label="Loading invoices" />
  if (invoices.isError) return <LoadError error={invoices.error} onRetry={() => void invoices.refetch()} />
  if (invoices.data.items.length === 0) return <EmptyState title="No invoices recorded for this client" />

  return (
    <>
      <div className={TABLE.wrapper}>
        <table className={TABLE.table}>
          <caption className="sr-only">Invoices</caption>
          <thead>
            <tr>
              <th scope="col" className={TABLE.th}>
                Invoice no.
              </th>
              <th scope="col" className={TABLE.th}>
                Invoice date
              </th>
              <th scope="col" className={`${TABLE.th} text-right`}>
                Excl. VAT
              </th>
              <th scope="col" className={`${TABLE.th} text-right`}>
                Total
              </th>
              <th scope="col" className={TABLE.th}>
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {invoices.data.items.map((invoice) => (
              <tr key={invoice.id}>
                <td className={`${TABLE.td} whitespace-nowrap font-mono text-xs font-semibold`}>{invoice.invoiceNumber}</td>
                <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(invoice.invoiceDate)}</td>
                <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                  <Money value={invoice.amountExclVat} />
                </td>
                <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                  <Money value={invoice.totalAmount} />
                </td>
                <td className={TABLE.td}>
                  <InvoiceStatusBadge status={invoice.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-slate-200 px-6 py-3 text-sm text-slate-600">
        {invoices.data.total > invoices.data.items.length ? `Showing the latest ${invoices.data.items.length} of ${invoices.data.total} invoices. ` : ''}
        <Link to="/invoices" className="font-medium text-blue-700 hover:underline">
          Open Invoice Tracking
        </Link>
      </p>
    </>
  )
}

/** Client 360: one client's details, figures, visits, contracts, invoices and history. */
export function ClientDetailPage() {
  const { id = '' } = useParams()
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [confirmToggle, setConfirmToggle] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const query = useQuery({ queryKey: ['clients', 'detail', id], queryFn: () => api.get<Client>(`/clients/${id}`) })
  const summary = useQuery({ queryKey: ['clients', 'summary', id], queryFn: () => api.get<ClientSummary>(`/clients/${id}/summary`), enabled: query.isSuccess })
  const features = useQuery({ queryKey: ['clients', 'features'], queryFn: () => api.get<ClientFeatures>('/clients/features'), staleTime: 60_000 })
  const toggle = useMutation({
    mutationFn: (client: Client) => api.post<Client>(`/clients/${client.id}/${client.isActive ? 'deactivate' : 'reactivate'}`),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['masters'] }),
      ])
      setNotice(`${updated.name} is now ${CLIENT_STATUS_LABELS[updated.isActive ? 'active' : 'inactive']}.`)
      setConfirmToggle(false)
    },
  })

  const back = (
    <Link to="/clients" className="text-sm font-medium text-blue-700 hover:underline">
      ← All clients
    </Link>
  )

  if (query.isPending) return <Spinner label="Loading client" />

  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404

    return (
      <>
        <div className="mb-4">{back}</div>
        <Card>{missing ? <EmptyState title="Client not found" description="It may have been opened from an old link." /> : <LoadError error={query.error} onRetry={() => void query.refetch()} />}</Card>
      </>
    )
  }

  const client = query.data
  const withDetails = features.data?.clientDetails === true
  const canExportContracts = auth.can('AMC_CONTRACTS', 'VIEW') && auth.can('AMC_CONTRACTS', 'EXPORT')
  const canExportVisits = auth.can('AMC_SCHEDULE', 'VIEW') && auth.can('AMC_SCHEDULE', 'EXPORT')
  const canExportInvoices = auth.can('INVOICES', 'VIEW') && auth.can('INVOICES', 'EXPORT')
  const asOf = summary.data?.asOf

  return (
    <>
      <div className="mb-4">{back}</div>

      <PageHeader
        title={client.name}
        description={`${client.code} · Client 360: details, AMC contracts, visits, invoices and history.`}
        actions={
          <>
            {auth.can('CLIENTS', 'EDIT') && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {auth.can('CLIENTS', 'DELETE') && (
              <Button variant={client.isActive ? 'danger' : 'secondary'} onClick={() => setConfirmToggle(true)}>
                {client.isActive ? 'Disable' : 'Enable'}
              </Button>
            )}
          </>
        }
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}
      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}
      {!client.isActive && (
        <div className="mb-4">
          <Alert tone="info">This client is disabled. Its contracts, invoices and history stay as they are; it cannot be chosen for new contracts.</Alert>
        </div>
      )}

      <div className="space-y-6">
        <section aria-label="Client figures">
          {summary.isPending && <Spinner size="sm" label="Loading client figures" />}
          {summary.isError && (
            <Card>
              <LoadError error={summary.error} onRetry={() => void summary.refetch()} />
            </Card>
          )}
          {summary.data && <SummaryStrip summary={summary.data} />}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section id="client-details-heading" title="Client details">
            <dl className="px-6 py-4">
              <DetailRow label="Client code">
                <span className="font-mono">{client.code}</span>
              </DetailRow>
              <DetailRow label="Status">
                <ClientStatusBadge active={client.isActive} />
              </DetailRow>
              {withDetails && <DetailRow label="Client type">{client.clientType ? CLIENT_TYPE_LABELS[client.clientType] : <OrDash value={null} />}</DetailRow>}
              {withDetails && (
                <DetailRow label="VAT number">
                  <OrDash value={client.vatNumber ?? null} />
                </DetailRow>
              )}
              <DetailRow label="Contact person">
                <OrDash value={client.contactPerson} />
              </DetailRow>
              <DetailRow label="Phone">
                {client.phone ? (
                  <a href={`tel:${client.phone.replace(/[^+\d]/g, '')}`} className="text-blue-700 hover:underline">
                    {client.phone}
                  </a>
                ) : (
                  <OrDash value={null} />
                )}
              </DetailRow>
              <DetailRow label="Email">
                {client.email ? (
                  <a href={`mailto:${client.email}`} className="break-all text-blue-700 hover:underline">
                    {client.email}
                  </a>
                ) : (
                  <OrDash value={null} />
                )}
              </DetailRow>
              <DetailRow label="Address">
                <OrDash value={client.address} />
              </DetailRow>
              <DetailRow label="Remarks">
                <OrDash value={client.notes} />
              </DetailRow>
              <DetailRow label="Added">{formatDateTime(client.createdAt)}</DetailRow>
              <DetailRow label="Last updated">{formatDateTime(client.updatedAt)}</DetailRow>
            </dl>
          </Section>

          <Section id="client-renewals-heading" title="Contract renewals">
            {!auth.can('AMC_CONTRACTS', 'VIEW') ? (
              <p className="px-6 py-4 text-sm text-slate-600">{NO_ACCESS('AMC contracts')}</p>
            ) : summary.data?.renewals ? (
              <>
                <p className="px-6 pt-4 text-sm text-slate-600">Active contracts whose validity has ended or ends within {summary.data.renewals.windowDays} days.</p>
                <Renewals renewals={summary.data.renewals} />
              </>
            ) : (
              summary.isPending && <Spinner size="sm" label="Loading renewals" />
            )}
          </Section>
        </div>

        <Section
          id="client-visits-heading"
          title="Upcoming AMC visits"
          actions={
            canExportVisits && asOf ? (
              <ExportButtons
                what="upcoming visits"
                fileStem="amc-schedule"
                size="sm"
                path={(format) => `/amc/visits/export?${new URLSearchParams({ format, clientId: client.id, from: asOf, status: OPEN_VISIT_STATUSES }).toString()}`}
                onError={setExportError}
              />
            ) : undefined
          }
        >
          {!auth.can('AMC_SCHEDULE', 'VIEW') ? (
            <p className="px-6 py-4 text-sm text-slate-600">{NO_ACCESS('the AMC schedule')}</p>
          ) : asOf ? (
            <UpcomingVisits clientId={client.id} from={asOf} />
          ) : (
            summary.isPending && <Spinner size="sm" label="Loading visits" />
          )}
        </Section>

        <Section
          id="client-contracts-heading"
          title="AMC contracts"
          actions={
            canExportContracts ? (
              <ExportButtons what="AMC contracts" fileStem={`client-contracts-${client.code.toLowerCase()}`} size="sm" path={(format) => `/clients/${client.id}/contracts/export?format=${format}`} onError={setExportError} />
            ) : undefined
          }
        >
          <LinkedContracts filter={{ clientId: client.id }} emptyTitle="No AMC contracts for this client" />
        </Section>

        <Section
          id="client-invoices-heading"
          title="Invoices"
          actions={
            canExportInvoices ? (
              <ExportButtons what="invoices" fileStem="invoice-tracking" size="sm" path={(format) => `/invoices/export?${new URLSearchParams({ format, clientId: client.id }).toString()}`} onError={setExportError} />
            ) : undefined
          }
        >
          {auth.can('INVOICES', 'VIEW') ? <RelatedInvoices clientId={client.id} /> : <p className="px-6 py-4 text-sm text-slate-600">{NO_ACCESS('invoices')}</p>}
        </Section>

        <Section id="client-history-heading" title="History">
          <RecordHistory
            path={`/clients/${client.id}/history`}
            queryKey={['clients', 'history', client.id]}
            actionLabels={ACTION_LABELS}
            fieldLabels={FIELD_LABELS}
            formatValue={(field, value) => (field === 'clientType' && typeof value === 'string' ? (CLIENT_TYPE_LABELS[value as ClientType] ?? null) : null)}
            emptyTitle="No history recorded for this client"
          />
        </Section>
      </div>

      {editing && (
        <ClientFormModal
          client={client}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setNotice(`${saved.name} was updated.`)
            setEditing(false)
          }}
        />
      )}
      {confirmToggle && (
        <ConfirmDialog
          title={client.isActive ? 'Disable client' : 'Enable client'}
          message={
            client.isActive
              ? `${client.name} will no longer be offered for new contracts. Existing contracts, invoices and history are kept.`
              : `${client.name} will be offered again for new contracts.`
          }
          confirmLabel={client.isActive ? 'Disable' : 'Enable'}
          danger={client.isActive}
          loading={toggle.isPending}
          error={toggle.isError ? errorMessage(toggle.error) : null}
          onConfirm={() => toggle.mutate(client)}
          onCancel={() => {
            toggle.reset()
            setConfirmToggle(false)
          }}
        />
      )}
    </>
  )
}
