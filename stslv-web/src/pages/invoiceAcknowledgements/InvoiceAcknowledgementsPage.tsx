import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { StatTile } from '../../components/StatTile'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, EmptyState, Modal, OptionsNotice, PageHeader, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatBusinessDateTime } from '../../lib/businessDate'
import { cx, formatDate } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import { queryString } from '../amc/amcApi'
import { Filter, FilterPanel, Pager } from '../amc/components'
import { AcknowledgementViewer, AttachAcknowledgementDialog, ReplaceDocumentDialog } from './AcknowledgementDialogs'
import {
  ACKNOWLEDGEMENT_NOTE,
  subjectOf,
  AMOUNT_COLUMNS,
  COLUMN_IDS,
  COLUMN_LABELS,
  serviceLabel,
  STATUS_LABELS,
  useHiddenColumns,
  type AcknowledgementItem,
  type AcknowledgementList,
  type AcknowledgementOptions,
  type ColumnId,
  type Sort,
} from './invoiceAcknowledgementTypes'

const PAGE_SIZE = 50
const DEFAULT_MAX_MB = 12

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    {path}
  </svg>
)

interface Filters {
  search: string
  clientId: string
  contractId: string
  invoiceNo: string
  status: string
  dateBasis: string
  fromDate: string
  toDate: string
}

const NO_FILTERS: Filters = { search: '', clientId: '', contractId: '', invoiceNo: '', status: '', dateBasis: 'INVOICE_DATE', fromDate: '', toDate: '' }

const Missing = ({ title }: { title: string }) => (
  <span className="text-slate-400" title={title}>
    —<span className="sr-only">{title}</span>
  </span>
)

/** Pending (amber) or Acknowledged (green). Green appears only for a status the server confirmed. */
export function AcknowledgementStatusBadge({ item }: { item: AcknowledgementItem }) {
  if (item.status === 'ACKNOWLEDGED') {
    return (
      <span data-status="ACKNOWLEDGED" className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-300">
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <path d="M4.5 10.5l3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {STATUS_LABELS.ACKNOWLEDGED}
      </span>
    )
  }
  return (
    <span>
      <span data-status="PENDING" className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-300">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        {STATUS_LABELS.PENDING}
      </span>
      {item.document && <span className="mt-1 block text-xs text-amber-800">Document attached, awaiting OK / Confirm</span>}
    </span>
  )
}

function HideColumnsDialog({ hidden, amountsVisible, onSave, onClose }: { hidden: ReadonlySet<ColumnId>; amountsVisible: boolean; onSave: (hidden: ReadonlySet<ColumnId>) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Set<ColumnId>>(new Set(hidden))
  const toggle = (id: ColumnId) => {
    const next = new Set(draft)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setDraft(next)
  }
  const offered = COLUMN_IDS.filter((id) => amountsVisible || !AMOUNT_COLUMNS.includes(id))

  return (
    <Modal
      title="Hide columns"
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="secondary" onClick={() => setDraft(new Set())}>
            Reset to Default
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => onSave(draft)}>Apply</Button>
          </div>
        </div>
      }
    >
      <p className="mb-3 text-sm text-slate-600">AMC Contract, Invoice No., Acknowledgement Status and Actions are always shown. Downloads include only the columns shown here.</p>
      <fieldset>
        <legend className="sr-only">Columns to show</legend>
        <ul className="grid gap-1 sm:grid-cols-2">
          {offered.map((id) => (
            <li key={id}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-sky-50">
                <input type="checkbox" checked={!draft.has(id)} onChange={() => toggle(id)} className="h-4 w-4 rounded border-slate-300 accent-[#1479BD]" />
                {COLUMN_LABELS[id]}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </Modal>
  )
}

function SortHeader({ label, sort, current, dir, onSort, className }: { label: string; sort: Sort; current: Sort | ''; dir: 'asc' | 'desc'; onSort: (sort: Sort) => void; className?: string }) {
  const active = current === sort

  return (
    <th scope="col" className={cx(TABLE.th, className)} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(sort)} className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-[#1479BD]">
        {label}
        <span aria-hidden="true">{active ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  )
}

type Dialog = { kind: 'attach' | 'replace' | 'view'; item: AcknowledgementItem } | null

export function InvoiceAcknowledgementsPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const userId = auth.user?.id ?? 'anonymous'
  const [hidden, setHidden] = useHiddenColumns(userId)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)

  const [draft, setDraft] = useState<Filters>(NO_FILTERS)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [sort, setSort] = useState<Sort | ''>('')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)

  const canCreate = auth.can('INVOICE_ACKNOWLEDGEMENTS', 'CREATE')
  const canEdit = auth.can('INVOICE_ACKNOWLEDGEMENTS', 'EDIT')
  const canExport = auth.can('INVOICE_ACKNOWLEDGEMENTS', 'EXPORT')
  const canViewContract = auth.can('AMC_CONTRACTS', 'VIEW')

  const options = useQuery({ queryKey: ['invoice-acknowledgements', 'options'], queryFn: () => api.get<AcknowledgementOptions>('/invoice-acknowledgements/options') })
  const params = { ...filters, ...(sort ? { sort, dir } : {}) }
  const list = useQuery({
    queryKey: ['invoice-acknowledgements', 'list', { ...params, page }],
    queryFn: () => api.get<AcknowledgementList>(`/invoice-acknowledgements${queryString({ ...params, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  })
  const maxMb = options.data?.limits.maxMb ?? DEFAULT_MAX_MB

  const set = (key: keyof Filters) => (value: string) => setDraft({ ...draft, [key]: value })
  const rangeProblem = draft.fromDate && draft.toDate && draft.fromDate > draft.toDate ? 'The From date must be on or before the To date.' : null
  const apply = (event: FormEvent) => {
    event.preventDefault()
    if (rangeProblem) return
    setFilters({ ...draft, search: draft.search.trim(), invoiceNo: draft.invoiceNo.trim() })
    setPage(1)
  }
  const reset = () => {
    setDraft(NO_FILTERS)
    setFilters(NO_FILTERS)
    setPage(1)
  }
  const onSort = (next: Sort) => {
    if (sort === next) setDir(dir === 'asc' ? 'desc' : 'asc')
    else {
      setSort(next)
      setDir('asc')
    }
    setPage(1)
  }
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS)
  const pendingChanges = JSON.stringify({ ...draft, search: draft.search.trim(), invoiceNo: draft.invoiceNo.trim() }) !== JSON.stringify(filters)

  const data = list.data
  // The API decides (amounts only with Accounts: View); before the first answer, the same rule from the session.
  const amountsVisible = data ? data.kpis.serviceValueTotal !== null : auth.can('ACCOUNTS', 'VIEW')
  const shown = (id: ColumnId) => !hidden.has(id) && (amountsVisible || !AMOUNT_COLUMNS.includes(id))
  const visible = COLUMN_IDS.filter(shown)
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['invoice-acknowledgements'] })

  return (
    <>
      <PageHeader
        title="Invoice Acknowledgements"
        description="The client's acknowledgement document for each invoice on Accounts (a service with an Invoice No.). Attach the document, then select OK / Confirm: the invoice turns green, Acknowledged. Acknowledgement is not payment."
        actions={
          canExport ? (
            <ExportButtons
              what="Invoice Acknowledgements"
              fileStem="invoice-acknowledgements"
              path={(format) => `/invoice-acknowledgements/export${queryString({ ...params, hidden: [...hidden].join(','), format })}`}
              onError={setExportError}
            />
          ) : undefined
        }
      />

      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}

      <section aria-label="Invoice acknowledgement figures" className="mb-4">
        <ul className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { id: 'total', label: 'Invoices', count: data?.kpis.total ?? 0, hint: 'Services with an Invoice No.', tone: 'from-[#0b3b66] to-[#1479BD]', edge: '#0b3b66', path: <><path d="M7 3.5h7.5L18 7v13.5H7z" strokeLinejoin="round" /><path d="M10 11h5M10 14.5h5" strokeLinecap="round" /></> },
            { id: 'pending', label: 'Pending', count: data?.kpis.pending ?? 0, hint: 'Not yet acknowledged', tone: 'from-amber-500 to-amber-400', edge: '#d97706', path: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4.5l3 2" strokeLinecap="round" /></> },
            { id: 'awaiting', label: 'Awaiting Confirmation', count: data?.kpis.awaitingConfirmation ?? 0, hint: 'Document attached, not confirmed', tone: 'from-[#1479BD] to-sky-400', edge: '#1479BD', path: <><path d="M12 4v10M8 10l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 19h14" strokeLinecap="round" /></> },
            { id: 'acknowledged', label: 'Acknowledged', count: data?.kpis.acknowledged ?? 0, hint: 'Confirmed: not a payment', tone: 'from-emerald-600 to-emerald-400', edge: '#16a34a', path: <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" /> },
          ].map((card, index) => (
            <li key={card.id} data-kpi={card.id} className="flex flex-col [&>.contract-tile]:flex-1">
              <StatTile label={card.label} count={card.count} hint={data ? card.hint : 'Loading…'} icon={icon(card.path)} tone={card.tone} edge={card.edge} position={index} />
            </li>
          ))}
        </ul>
      </section>

      <Card>
        <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
            <p className="text-xs text-slate-600" id="acknowledgement-note">
              {ACKNOWLEDGEMENT_NOTE}
            </p>
            <p className="text-sm text-slate-500" aria-live="polite">
              {data ? (
                <>
                  <span className="font-semibold tabular-nums text-slate-800">{data.total}</span> {data.total === 1 ? 'invoice' : 'invoices'}
                </>
              ) : (
                'Loading…'
              )}
            </p>
          </div>
          <FilterPanel id="invoice-acknowledgements">
            <form className="grid gap-4 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4" onSubmit={apply} aria-label="Filters">
              <Filter label="Search" className="sm:col-span-2">
                {(id, className) => (
                  <input id={id} type="search" value={draft.search} onChange={(event) => set('search')(event.target.value)} placeholder="Contract, client, invoice no., service report no. or document" className={className} />
                )}
              </Filter>
              <Filter label="Client">
                {(id, className) => (
                  <select id={id} value={draft.clientId} onChange={(event) => set('clientId')(event.target.value)} className={className}>
                    <option value="">All clients</option>
                    <OptionsNotice source={options} count={options.data?.clients.length ?? 0} empty="No clients with invoices" />
                    {(options.data?.clients ?? []).map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                )}
              </Filter>
              <Filter label="AMC Contract">
                {(id, className) => (
                  <select id={id} value={draft.contractId} onChange={(event) => set('contractId')(event.target.value)} className={className}>
                    <option value="">All contracts</option>
                    <OptionsNotice source={options} count={options.data?.contracts.length ?? 0} empty="No contracts with invoices" />
                    {(options.data?.contracts ?? []).map((contract) => (
                      <option key={contract.id} value={contract.id}>
                        {contract.reference} · {contract.client} · {contract.system}
                      </option>
                    ))}
                  </select>
                )}
              </Filter>
              <Filter label="Invoice No.">
                {(id, className) => <input id={id} type="text" maxLength={50} value={draft.invoiceNo} onChange={(event) => set('invoiceNo')(event.target.value)} className={className} />}
              </Filter>
              <Filter label="Acknowledgement">
                {(id, className) => (
                  <select id={id} value={draft.status} onChange={(event) => set('status')(event.target.value)} className={className}>
                    <option value="">All</option>
                    <option value="PENDING">Pending</option>
                    <option value="ACKNOWLEDGED">Acknowledged</option>
                  </select>
                )}
              </Filter>
              <Filter label="Date filter">
                {(id, className) => (
                  <select id={id} value={draft.dateBasis} onChange={(event) => set('dateBasis')(event.target.value)} className={className}>
                    <option value="INVOICE_DATE">Invoice date</option>
                    <option value="ACKNOWLEDGED_DATE">Acknowledged date (Oman)</option>
                  </select>
                )}
              </Filter>
              <Filter label="From">
                {(id, className) => <input id={id} type="date" value={draft.fromDate} onChange={(event) => set('fromDate')(event.target.value)} className={className} />}
              </Filter>
              <Filter label="To">
                {(id, className) => <input id={id} type="date" value={draft.toDate} onChange={(event) => set('toDate')(event.target.value)} className={className} aria-invalid={rangeProblem ? true : undefined} />}
              </Filter>
              <div className="flex flex-wrap items-end justify-between gap-2 sm:col-span-2 lg:col-span-4">
                <div className="flex flex-wrap items-end gap-2">
                  <Button type="submit" variant={pendingChanges ? 'primary' : 'secondary'} disabled={Boolean(rangeProblem)}>
                    Apply
                  </Button>
                  <Button variant="secondary" disabled={!filtered && !pendingChanges} onClick={reset}>
                    Reset
                  </Button>
                  {rangeProblem ? (
                    <span role="alert" className="text-xs text-red-700">
                      {rangeProblem}
                    </span>
                  ) : (
                    pendingChanges && <span className="text-xs text-slate-500">Filters changed. Select Apply to update the list.</span>
                  )}
                </div>
                <Button variant="secondary" onClick={() => setColumnsOpen(true)}>
                  Hide Columns · {visible.length} of {COLUMN_IDS.filter((id) => amountsVisible || !AMOUNT_COLUMNS.includes(id)).length} shown
                </Button>
                <span className="basis-full text-xs text-slate-500">
                  Invoice Date is the date of the Zoho invoice with the same number in Invoice Tracking, where one is recorded. A manual Invoice No. carries no date, so none is shown.
                </span>
              </div>
            </form>
          </FilterPanel>
        </div>

        {list.isPending && <Spinner label="Loading invoices" />}

        {list.isError && (
          <div className="p-4">
            <Alert>
              {errorMessage(list.error)}{' '}
              <button type="button" className="font-medium underline" onClick={() => void list.refetch()}>
                Try again
              </button>
            </Alert>
          </div>
        )}

        {data && data.items.length === 0 && (
          <EmptyState
            title="No invoices found"
            description={filtered ? 'No invoice matches these filters. Reset the filters to see every invoice.' : 'An invoice appears here when its Invoice No. is entered on a service on Accounts.'}
            action={filtered ? <Button variant="secondary" onClick={reset}>Reset</Button> : undefined}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">Invoice Acknowledgements</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.snHead}>
                      #
                    </th>
                    <SortHeader label="AMC Contract" sort="reference" current={sort} dir={dir} onSort={onSort} />
                    {shown('client') && <SortHeader label={COLUMN_LABELS.client} sort="client" current={sort} dir={dir} onSort={onSort} />}
                    {shown('service') && <th scope="col" className={TABLE.th}>{COLUMN_LABELS.service}</th>}
                    <SortHeader label="Invoice No." sort="invoiceNo" current={sort} dir={dir} onSort={onSort} />
                    {shown('invoiceDate') && <SortHeader label={COLUMN_LABELS.invoiceDate} sort="invoiceDate" current={sort} dir={dir} onSort={onSort} />}
                    {shown('serviceValue') && <th scope="col" className={cx(TABLE.th, 'text-right')}>{COLUMN_LABELS.serviceValue}</th>}
                    {shown('invoiceValue') && <th scope="col" className={cx(TABLE.th, 'text-right')}>{COLUMN_LABELS.invoiceValue}</th>}
                    {shown('serviceReportNo') && <th scope="col" className={TABLE.th}>{COLUMN_LABELS.serviceReportNo}</th>}
                    <SortHeader label="Acknowledgement Status" sort="status" current={sort} dir={dir} onSort={onSort} />
                    {shown('acknowledgedAt') && <SortHeader label={COLUMN_LABELS.acknowledgedAt} sort="acknowledgedAt" current={sort} dir={dir} onSort={onSort} />}
                    {shown('uploadedBy') && <th scope="col" className={TABLE.th}>{COLUMN_LABELS.uploadedBy}</th>}
                    {shown('document') && <th scope="col" className={TABLE.th}>{COLUMN_LABELS.document}</th>}
                    <th scope="col" className={TABLE.th}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((item, index) => (
                    <tr key={`${item.visitId}-${item.invoiceNo}`} className={cx(TABLE.row, item.status === 'ACKNOWLEDGED' && 'bg-emerald-50/40')} data-status={item.status}>
                      <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                      <td className={`${TABLE.td} whitespace-nowrap font-mono text-sm font-semibold text-[#0b3b66]`}>
                        {canViewContract ? (
                          <Link to={`/amc/contracts/${item.contract.id}`} className="hover:text-[#1479BD] hover:underline" aria-label={`Contract ${item.reference}`}>
                            {item.reference}
                          </Link>
                        ) : (
                          item.reference
                        )}
                      </td>
                      {shown('client') && <td className={`${TABLE.td} ${TABLE.text} font-semibold text-slate-900`}>{item.client.name}</td>}
                      {shown('service') && (
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          {serviceLabel(item.service)}
                          {item.completedDate && <div className="text-xs text-slate-500">Completed {formatDate(item.completedDate)}</div>}
                        </td>
                      )}
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        <span className="font-mono text-sm font-semibold text-slate-900">{item.invoiceNo}</span>
                        {item.invoiceEnteredAt && <div className="text-xs text-slate-500">Entered {formatBusinessDateTime(item.invoiceEnteredAt)}</div>}
                      </td>
                      {shown('invoiceDate') && <td className={`${TABLE.td} whitespace-nowrap`}>{item.invoiceDate ? formatDate(item.invoiceDate) : <Missing title="No Zoho invoice date recorded" />}</td>}
                      {shown('serviceValue') && <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{item.serviceValue ? formatMoney(item.serviceValue) : <Missing title="No service value set" />}</td>}
                      {shown('invoiceValue') && <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{item.invoiceValue ? formatMoney(item.invoiceValue) : <Missing title="No Zoho invoice value recorded" />}</td>}
                      {shown('serviceReportNo') && <td className={`${TABLE.td} whitespace-nowrap font-mono text-sm`}>{item.serviceReportNo ?? <Missing title="No service report number" />}</td>}
                      <td className={TABLE.td}>
                        <AcknowledgementStatusBadge item={item} />
                      </td>
                      {shown('acknowledgedAt') && (
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          {item.acknowledgedAt ? (
                            <>
                              {formatBusinessDateTime(item.acknowledgedAt)}
                              <div className="text-xs text-slate-500">by {item.acknowledgedBy?.fullName}</div>
                            </>
                          ) : (
                            <Missing title="Not acknowledged" />
                          )}
                        </td>
                      )}
                      {shown('uploadedBy') && <td className={`${TABLE.td} ${TABLE.text}`}>{item.document?.uploadedBy.fullName ?? <Missing title="No document" />}</td>}
                      {shown('document') && <td className={`${TABLE.td} ${TABLE.unbroken} text-sm`}>{item.document?.originalName ?? <Missing title="No document" />}</td>}
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        <div className="flex flex-wrap gap-1.5">
                          {item.status === 'PENDING' && canCreate && (
                            <Button size="sm" variant={item.document ? 'primary' : 'secondary'} onClick={() => setDialog({ kind: 'attach', item })} aria-label={`${item.document ? 'Review and confirm' : 'Attach acknowledgement for'} ${subjectOf(item)}`}>
                              {item.document ? 'Review & Confirm' : 'Attach Acknowledgement'}
                            </Button>
                          )}
                          {item.document && (
                            <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'view', item })} aria-label={`View the acknowledgement document of ${subjectOf(item)}`}>
                              View Document
                            </Button>
                          )}
                          {item.status === 'ACKNOWLEDGED' && canEdit && (
                            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'replace', item })} aria-label={`Replace the acknowledgement document of ${subjectOf(item)}`}>
                              Replace Document
                            </Button>
                          )}
                          {item.status === 'PENDING' && !canCreate && !item.document && <span className="text-xs text-slate-400">No action</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {amountsVisible && (shown('serviceValue') || shown('invoiceValue')) && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold text-slate-900">
                      <th scope="row" colSpan={2 + (shown('client') ? 1 : 0) + (shown('service') ? 1 : 0) + 1 + (shown('invoiceDate') ? 1 : 0)} className={`${TABLE.td} text-right`}>
                        Total Filtered ({data.kpis.total} {data.kpis.total === 1 ? 'invoice' : 'invoices'}, all pages)
                      </th>
                      {shown('serviceValue') && <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{formatMoney(data.kpis.serviceValueTotal ?? '0.000')}</td>}
                      {shown('invoiceValue') && <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{formatMoney(data.kpis.invoiceValueTotal ?? '0.000')}</td>}
                      <td colSpan={2 + (shown('serviceReportNo') ? 1 : 0) + (shown('acknowledgedAt') ? 1 : 0) + (shown('uploadedBy') ? 1 : 0) + (shown('document') ? 1 : 0)} className={TABLE.td} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>

      {columnsOpen && (
        <HideColumnsDialog
          hidden={hidden}
          amountsVisible={amountsVisible}
          onSave={(next) => {
            setHidden(next)
            setColumnsOpen(false)
          }}
          onClose={() => setColumnsOpen(false)}
        />
      )}

      {dialog?.kind === 'attach' && (
        <AttachAcknowledgementDialog
          item={dialog.item}
          maxMb={maxMb}
          onSaved={() => void refresh()}
          onConfirmed={(saved) => {
            setDialog(null)
            setNotice(`Invoice ${saved.invoiceNo} (${saved.reference}) is now Acknowledged.`)
            void refresh()
          }}
          onClose={() => {
            setDialog(null)
            void refresh()
          }}
        />
      )}
      {dialog?.kind === 'replace' && (
        <ReplaceDocumentDialog
          item={dialog.item}
          maxMb={maxMb}
          onReplaced={(saved) => {
            setDialog(null)
            setNotice(`The acknowledgement document of invoice ${saved.invoiceNo} was replaced. The earlier version is kept.`)
            void refresh()
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'view' && dialog.item.document && <AcknowledgementViewer item={dialog.item} onClose={() => setDialog(null)} />}
    </>
  )
}
