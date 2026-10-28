import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { LinkedContracts } from '../../components/LinkedContracts'
import { PageTabs, TabPanel, useTabsLayout } from '../../components/PageTabs'
import { ContactChip } from '../../components/ProfileParts'
import { LoadError, Money, OrDash } from '../../components/records'
import { RecordHistory } from '../../components/RecordHistory'
import { TABLE } from '../../components/table'
import { Alert, BannerButton, Card, ConfirmDialog, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { cx, formatCount, formatDate, formatDateTime } from '../../lib/format'
import type { PagedInvoices } from '../../lib/invoiceTypes'
import { formatMoney } from '../../lib/money'
import { CLIENT_STATUS_LABELS, CLIENT_TYPE_LABELS, type Client, type ClientFeatures, type ClientSummary, type ClientType } from '../../lib/types'
import { VisitStatusPill } from '../amc/components'
import type { VisitList } from '../amc/types'
import { InvoiceStatusBadge } from '../invoices/InvoicesTable'
import { ClientFormModal } from './ClientFormModal'
import { initialsOf } from './clientAvatarHelpers'
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

const NO_ACCESS = (module: string) => `Your role does not include ${module}.`

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

interface Stat {
  label: string
  value: ReactNode | null
  hint: ReactNode
  warn?: boolean
}

function clientStats(summary: ClientSummary): Stat[] {
  const { contracts, visits, invoices } = summary

  return [
    { label: 'Total AMC contracts', value: contracts ? formatCount(contracts.total) : null, hint: contracts ? `${contracts.draft} draft · ${contracts.expired} expired · ${contracts.cancelled} cancelled` : NO_ACCESS('AMC contracts') },
    { label: 'Active AMC contracts', value: contracts ? formatCount(contracts.active) : null, hint: contracts ? 'Status Active' : NO_ACCESS('AMC contracts') },
    { label: 'Active AMC value', value: contracts ? formatMoney(contracts.activeValue) : null, hint: contracts ? `All contracts except cancelled: ${formatMoney(contracts.nonCancelledValue)}` : NO_ACCESS('AMC contracts') },
    { label: 'Final credit (active contracts)', value: contracts ? formatMoney(contracts.finalCreditTotal) : null, hint: contracts ? `Entered on ${contracts.finalCreditRecorded} of ${contracts.active} active ${contracts.active === 1 ? 'contract' : 'contracts'}` : NO_ACCESS('AMC contracts') },
    { label: 'Upcoming visits', value: visits ? formatCount(visits.upcoming) : null, hint: visits ? (visits.nextVisitDate ? `Next on ${formatDate(visits.nextVisitDate)}` : 'None scheduled') : NO_ACCESS('the AMC schedule') },
    { label: 'Overdue visits', value: visits ? formatCount(visits.overdue) : null, hint: visits ? `${formatCount(visits.completed)} completed · ${formatCount(visits.readyForInvoice)} ready for invoice` : NO_ACCESS('the AMC schedule'), warn: !!visits && visits.overdue > 0 },
    {
      label: 'Invoices issued',
      value: invoices ? formatCount(invoices.issued) : null,
      hint: invoices ? `${formatMoney(invoices.issuedTotal)} incl. VAT${invoices.lastInvoiceDate ? ` · last ${formatDate(invoices.lastInvoiceDate)}` : ''}${invoices.cancelled > 0 ? ` · ${invoices.cancelled} cancelled` : ''}` : NO_ACCESS('invoices'),
    },
    { label: 'Paid / unpaid invoices', value: null, hint: 'Payments are not recorded in STSLV AMC.' },
  ]
}

/** The eight figures as one card, four across, with dividers. */
function StatGrid({ summary }: { summary: ClientSummary }) {
  return (
    <dl className="grid grid-cols-2 divide-x divide-y divide-slate-200 lg:grid-cols-4">
      {clientStats(summary).map((stat) => (
        <div key={stat.label} className={cx('min-w-0 px-5 py-4', stat.warn && 'bg-amber-50/60')}>
          <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{stat.label}</dt>
          <dd className={cx('mt-1.5 tabular-nums', stat.value === null ? 'text-base font-bold text-slate-400' : 'text-2xl font-bold leading-none text-[#0b3b66]')}>{stat.value === null ? 'Not available' : stat.value}</dd>
          <dd className={cx('mt-1.5 text-xs leading-snug', stat.warn ? 'text-amber-700' : 'text-slate-500')}>{stat.hint}</dd>
        </div>
      ))}
    </dl>
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
  const [tab, setTab] = useState<'visits' | 'contracts' | 'invoices' | 'renewals' | 'history'>('visits')
  const layout = useTabsLayout()

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
    <Link to="/clients" className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-[#0b3b66] shadow-sm hover:bg-sky-50">
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

  const exportBar = (buttons: ReactNode) => (buttons ? <div className="flex justify-end border-b border-slate-200 bg-slate-50/70 px-4 py-2.5">{buttons}</div> : null)

  const PANEL: Record<typeof tab, [string, string]> = {
    visits: ['Upcoming visits', 'Open AMC visits of this client, from today onwards.'],
    contracts: ['AMC contracts', 'Every maintenance contract held by this client.'],
    invoices: ['Invoices', 'Invoices recorded against this client’s visits.'],
    renewals: ['Renewals', 'Contracts that have ended or are about to end.'],
    history: ['History', 'Every change made to this client record.'],
  }

  const tabsBlock = (
    <div className={layout.wrapper}>
      <PageTabs
        label="Client records"
        idPrefix="client-tab"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'visits', label: 'Upcoming visits', count: summary.data?.visits?.upcoming },
          { id: 'contracts', label: 'AMC contracts', count: summary.data?.contracts?.total },
          { id: 'invoices', label: 'Invoices', count: summary.data?.invoices?.issued },
          { id: 'renewals', label: 'Renewals', count: summary.data?.renewals?.total },
          { id: 'history', label: 'History' },
        ]}
      />
      <TabPanel idPrefix="client-tab" active={tab} title={PANEL[tab][0]} description={PANEL[tab][1]}>
        <div>
          {tab === 'visits' && (
            <>
              {exportBar(
                canExportVisits && asOf ? (
                  <ExportButtons
                    what="upcoming visits"
                    fileStem="amc-schedule"
                    size="sm"
                    path={(format) => `/amc/visits/export?${new URLSearchParams({ format, clientId: client.id, from: asOf, status: OPEN_VISIT_STATUSES }).toString()}`}
                    onError={setExportError}
                  />
                ) : null,
              )}
              {!auth.can('AMC_SCHEDULE', 'VIEW') ? <p className="px-6 py-4 text-sm text-slate-600">{NO_ACCESS('the AMC schedule')}</p> : asOf ? <UpcomingVisits clientId={client.id} from={asOf} /> : summary.isPending && <Spinner size="sm" label="Loading visits" />}
            </>
          )}
          {tab === 'contracts' && (
            <>
              {exportBar(canExportContracts ? <ExportButtons what="AMC contracts" fileStem={`client-contracts-${client.code.toLowerCase()}`} size="sm" path={(format) => `/clients/${client.id}/contracts/export?format=${format}`} onError={setExportError} /> : null)}
              <LinkedContracts filter={{ clientId: client.id }} emptyTitle="No AMC contracts for this client" />
            </>
          )}
          {tab === 'invoices' && (
            <>
              {exportBar(canExportInvoices ? <ExportButtons what="invoices" fileStem="invoice-tracking" size="sm" path={(format) => `/invoices/export?${new URLSearchParams({ format, clientId: client.id }).toString()}`} onError={setExportError} /> : null)}
              {auth.can('INVOICES', 'VIEW') ? <RelatedInvoices clientId={client.id} /> : <p className="px-6 py-4 text-sm text-slate-600">{NO_ACCESS('invoices')}</p>}
            </>
          )}
          {tab === 'renewals' &&
            (!auth.can('AMC_CONTRACTS', 'VIEW') ? (
              <p className="px-6 py-4 text-sm text-slate-600">{NO_ACCESS('AMC contracts')}</p>
            ) : summary.data?.renewals ? (
              <>
                <p className="px-6 pt-4 text-sm text-slate-600">Active contracts whose validity has ended or ends within {summary.data.renewals.windowDays} days.</p>
                <Renewals renewals={summary.data.renewals} />
              </>
            ) : (
              summary.isPending && <Spinner size="sm" label="Loading renewals" />
            ))}
          {tab === 'history' && (
            <RecordHistory
              path={`/clients/${client.id}/history`}
              queryKey={['clients', 'history', client.id]}
              actionLabels={ACTION_LABELS}
              fieldLabels={FIELD_LABELS}
              formatValue={(field, value) => (field === 'clientType' && typeof value === 'string' ? (CLIENT_TYPE_LABELS[value as ClientType] ?? null) : null)}
              emptyTitle="No history recorded for this client"
            />
          )}
        </div>
      </TabPanel>
    </div>
  )

  const statSection = (
    <section aria-label="Client figures">
      {summary.isPending && <Spinner size="sm" label="Loading client figures" />}
      {summary.isError && (
        <Card>
          <LoadError error={summary.error} onRetry={() => void summary.refetch()} />
        </Card>
      )}
      {summary.data && (
        <Card className="rounded-2xl">
          <StatGrid summary={summary.data} />
        </Card>
      )}
    </section>
  )

  const contacts = (
    <>
      {withDetails && (
        <ContactChip icon="receipt" label="VAT number">
          <OrDash value={client.vatNumber ?? null} />
        </ContactChip>
      )}
      <ContactChip icon="user" label="Contact person">
        <OrDash value={client.contactPerson} />
      </ContactChip>
      <ContactChip icon="phone" label="Phone">
        {client.phone ? (
          <a href={`tel:${client.phone.replace(/[^+\d]/g, '')}`} className="text-[#1479BD] hover:underline">
            {client.phone}
          </a>
        ) : (
          <OrDash value={null} />
        )}
      </ContactChip>
      <ContactChip icon="mail" label="Email" wrap>
        {client.email ? (
          <a href={`mailto:${client.email}`} title={client.email} className="text-[#1479BD] hover:underline">
            {client.email}
          </a>
        ) : (
          <OrDash value={null} />
        )}
      </ContactChip>
    </>
  )

  return (
    <>
      <div className="mb-4">{back}</div>

      <PageHeader
        title={client.name}
        description={`${client.code} · Client 360: details, AMC contracts, visits, invoices and history.`}
        actions={
          (auth.can('CLIENTS', 'EDIT') || auth.can('CLIENTS', 'DELETE')) && (
            <>
              {auth.can('CLIENTS', 'EDIT') && <BannerButton onClick={() => setEditing(true)}>Edit</BannerButton>}
              {auth.can('CLIENTS', 'DELETE') && (
                <BannerButton danger={client.isActive} onClick={() => setConfirmToggle(true)}>
                  {client.isActive ? 'Disable' : 'Enable'}
                </BannerButton>
              )}
            </>
          )
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
        <Card className="rounded-2xl">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4 p-5">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#0a3a66] to-[#2f9bd8] text-xl font-bold tracking-wide text-white shadow-md" aria-hidden="true">
              {initialsOf(client.name)}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-sky-50 px-2 py-0.5 font-mono text-xs font-bold text-[#0b3b66] ring-1 ring-inset ring-sky-200">{client.code}</span>
                <ClientStatusBadge active={client.isActive} />
              </div>
              {withDetails && <p className="mt-1.5 text-sm font-semibold text-slate-700">{client.clientType ? CLIENT_TYPE_LABELS[client.clientType] : 'Client type not set'}</p>}
            </div>
            <dl className="grid min-w-0 flex-1 basis-[30rem] gap-3 sm:grid-cols-2 2xl:grid-cols-4">{contacts}</dl>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-slate-200 bg-slate-50/70 px-5 py-2.5 text-xs text-slate-600">
            <p className="min-w-0">{client.address ? <><span className="font-bold text-slate-700">Address:</span> {client.address}</> : <span className="text-slate-400">No address</span>}{client.notes ? <> · <span className="font-bold text-slate-700">Remarks:</span> {client.notes}</> : null}</p>
            <p>Added {formatDateTime(client.createdAt)} · Updated {formatDateTime(client.updatedAt)}</p>
          </div>
        </Card>
        {statSection}
        {tabsBlock}
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
