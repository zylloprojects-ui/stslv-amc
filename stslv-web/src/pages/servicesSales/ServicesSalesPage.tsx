import { refreshOperationalData } from '../../lib/refreshOperationalData'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { KpiScopeNote } from '../../components/KpiScopeNote'
import { StatTile } from '../../components/StatTile'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, EmptyState, OptionsNotice, PageHeader, Spinner } from '../../components/ui'
import { scheduledPeriod } from '../../lib/scheduledPeriod'
import { api, ApiError, download, errorMessage, saveFile } from '../../lib/api'
import { cx, formatDate, formatDateTime } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import { queryString } from '../amc/amcApi'
import { Filter, FilterPanel, Pager } from '../amc/components'
import { CustomizeKpisDialog, HideColumnsDialog } from './ServicesSalesDialogs'
import { COLUMN_IDS, COLUMN_LABELS, PAGE_ONLY_COLUMNS, useHiddenColumns, useKpiLayout, type ColumnId, type KpiId } from './servicesSalesPreferences'
import {
  QUOTE_SUBMISSION_FILTERS,
  QUOTATION_MAX_LENGTH,
  SALES_STATUS_LABELS,
  SERVICE_STATUSES,
  SERVICE_STATUS_LABELS,
  isBrowserViewable,
  serviceCodeLabel,
  type SalesStatus,
  type ServicesSalesItem,
  type ServicesSalesKpis,
  type ServicesSalesList,
  type ServicesSalesOptions,
} from './servicesSalesTypes'

const PAGE_SIZE = 50
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    {path}
  </svg>
)

/** The look of each card. The figure comes from the API; only the label and position can be customised. */
const KPI_STYLE: Record<KpiId, { tone: string; edge: string; icon: ReactNode; figure: (kpis: ServicesSalesKpis) => number }> = {
  total: {
    tone: 'from-[#0b3b66] to-[#1479BD]',
    edge: '#0b3b66',
    icon: icon(<><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" /></>),
    figure: (kpis) => kpis.total,
  },
  notCompleted: {
    tone: 'from-rose-600 to-rose-400',
    edge: '#e11d48',
    icon: icon(<><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" strokeLinecap="round" /></>),
    figure: (kpis) => kpis.notCompleted,
  },
  quotePending: {
    tone: 'from-[#1479BD] to-sky-400',
    edge: '#1479BD',
    icon: icon(<><path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17Z" strokeLinejoin="round" /><path d="M9.5 8.5h5M9.5 12h3" strokeLinecap="round" /></>),
    figure: (kpis) => kpis.quotePending,
  },
  quoted: {
    tone: 'from-emerald-600 to-emerald-400',
    edge: '#10b981',
    icon: icon(<path d="m5 12.5 4.2 4.2L19 7" strokeLinecap="round" strokeLinejoin="round" />),
    figure: (kpis) => kpis.quoted,
  },
}

/** Red: not completed. Blue: completed, quote pending. Green: completed with a quotation number. */
const STATUS_TONE: Record<SalesStatus, { row: string; pill: string; dot: string }> = {
  NOT_COMPLETED: { row: 'bg-rose-50/50 shadow-[inset_4px_0_0_#e11d48]', pill: 'bg-rose-100 text-rose-800 ring-rose-200', dot: 'bg-rose-600' },
  QUOTE_PENDING: { row: 'bg-sky-50/60 shadow-[inset_4px_0_0_#1479BD]', pill: 'bg-sky-100 text-[#0b3b66] ring-sky-200', dot: 'bg-[#1479BD]' },
  QUOTED: { row: 'bg-emerald-50/50 shadow-[inset_4px_0_0_#10b981]', pill: 'bg-emerald-100 text-emerald-800 ring-emerald-200', dot: 'bg-emerald-600' },
}

function StatusLegend() {
  return (
    <ul aria-label="Status colours" className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-700">
      {(Object.keys(STATUS_TONE) as SalesStatus[]).map((status) => (
        <li key={status} className="flex items-center gap-2">
          <span className={cx('h-3 w-3 rounded-full', STATUS_TONE[status].dot)} aria-hidden="true" />
          {SALES_STATUS_LABELS[status]}
        </li>
      ))}
    </ul>
  )
}

/** Read only: completion is changed on Service Status. */
function ServiceStatusPill({ item }: { item: ServicesSalesItem }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', STATUS_TONE[item.salesStatus].pill)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', STATUS_TONE[item.salesStatus].dot)} aria-hidden="true" />
      {SERVICE_STATUS_LABELS[item.serviceStatus]}
    </span>
  )
}

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; message: string }

/**
 * The Quote No. field and Save action of one row. The typed value is kept when a save fails, and is replaced by
 * the stored value only while the user has not changed it.
 */
function QuotationCell({ item, canEdit, onSaved }: { item: ServicesSalesItem; canEdit: boolean; onSaved: () => Promise<unknown> }) {
  const stored = item.quotationNo ?? ''
  const [draft, setDraft] = useState(stored)
  const [baseline, setBaseline] = useState(stored)
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const label = `Quote No. for ${item.reference} ${serviceCodeLabel(item.service)}`

  // A new stored value (after a save or a refresh) replaces the field only while it holds the previous one.
  if (stored !== baseline) {
    if (draft === baseline) setDraft(stored)
    setBaseline(stored)
  }

  const completed = item.serviceStatus === 'COMPLETED'

  if (!completed || !canEdit) {
    return (
      <div>
        {item.quotationNo ? (
          <span className="font-mono text-sm font-semibold text-slate-900">{item.quotationNo}</span>
        ) : (
          <span className="text-slate-400" title={completed ? 'No quotation number recorded' : 'Available once the service is completed on Service Status'}>
            N/A
          </span>
        )}
        {item.quotationBeforeCompletion && <p className="mt-1 text-xs font-medium text-amber-700">Recorded before completion</p>}
        {!completed && canEdit && !item.quotationNo && <p className="mt-1 text-xs text-slate-500">After completion</p>}
      </div>
    )
  }

  const dirty = draft.trim() !== stored
  const save = async () => {
    setState({ kind: 'saving' })
    try {
      await api.patch(`/services-sales/${item.id}`, { quotationNo: draft.trim(), expectedUpdatedAt: item.updatedAt })
      // The field then shows the number as stored, without the spaces the API trims.
      setDraft(draft.trim())
      setState({ kind: 'saved' })
      await onSaved()
    } catch (error) {
      const field = error instanceof ApiError ? error.details.find((detail) => detail.field === 'quotationNo')?.message : undefined
      setState({ kind: 'failed', message: field ?? errorMessage(error) })
    }
  }

  return (
    <form
      className="min-w-52"
      onSubmit={(event) => {
        event.preventDefault()
        if (dirty) void save()
      }}
    >
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            if (state.kind !== 'saving') setState({ kind: 'idle' })
          }}
          maxLength={QUOTATION_MAX_LENGTH}
          placeholder="N/A"
          aria-label={label}
          aria-invalid={state.kind === 'failed'}
          disabled={state.kind === 'saving'}
          className="block w-36 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-sm shadow-sm placeholder:font-sans placeholder:text-slate-400"
        />
        <Button type="submit" size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} loading={state.kind === 'saving'} aria-label={`Save ${label}`}>
          Save
        </Button>
      </div>
      <p aria-live="polite" className="mt-1 min-h-4 text-xs">
        {state.kind === 'saved' && <span className="font-medium text-emerald-700">Saved</span>}
        {state.kind === 'failed' && <span className="font-medium text-red-700">{state.message}</span>}
        {state.kind === 'idle' && item.quotationUpdatedAt && !dirty && (
          <span className="text-slate-500">
            {item.quotationUpdatedBy ? `${item.quotationUpdatedBy}, ` : ''}
            {formatDateTime(item.quotationUpdatedAt)}
          </span>
        )}
      </p>
    </form>
  )
}

type ReportState = { kind: 'idle' } | { kind: 'busy'; action: 'view' | 'download' } | { kind: 'failed'; message: string }

/** How long a viewed report stays readable in its tab before the browser may free it. The tab keeps what it loaded. */
const VIEW_URL_LIFETIME_MS = 60_000

/**
 * The Service Report uploaded on Service Status for THIS visit: View and Download only, never upload or change. The
 * file is fetched with the signed-in user's token from /services-sales/:visitId/report, so it is always this
 * service's own report, and no storage path or unauthenticated link ever reaches the browser.
 */
function ServiceReportCell({ item }: { item: ServicesSalesItem }) {
  const report = item.serviceReport
  const [state, setState] = useState<ReportState>({ kind: 'idle' })

  if (!report) {
    return (
      <span className="whitespace-nowrap text-slate-400" title="No service report has been uploaded on Service Status for this service">
        Not uploaded
      </span>
    )
  }

  const subject = `service report for ${item.reference} ${serviceCodeLabel(item.service)}`
  const viewable = isBrowserViewable(report.mimeType)
  const fetchFile = async () => {
    const file = await download(`/services-sales/${item.id}/report`)
    // The original name as uploaded (already cleaned by the API), never the server's ASCII fallback.
    return { blob: new Blob([file.blob], { type: report.mimeType }), filename: report.originalName }
  }

  const save = async () => {
    setState({ kind: 'busy', action: 'download' })
    try {
      saveFile(await fetchFile(), report.originalName)
      setState({ kind: 'idle' })
    } catch (error) {
      setState({ kind: 'failed', message: errorMessage(error) })
    }
  }

  const view = async () => {
    // Word documents have no in-browser viewer: they are downloaded, with the same permission check.
    if (!viewable) return save()
    // Opened before the file is fetched, while the click still counts, so pop-up blockers allow it.
    const tab = window.open('', '_blank')

    if (!tab) {
      setState({ kind: 'failed', message: 'The browser blocked the new tab. Allow pop-ups for this site, or use Download.' })
      return
    }
    tab.opener = null
    setState({ kind: 'busy', action: 'view' })
    try {
      const url = URL.createObjectURL((await fetchFile()).blob)
      tab.location.href = url
      setTimeout(() => URL.revokeObjectURL(url), VIEW_URL_LIFETIME_MS)
      setState({ kind: 'idle' })
    } catch (error) {
      tab.close()
      setState({ kind: 'failed', message: errorMessage(error) })
    }
  }

  return (
    <div className="min-w-36" title={report.originalName}>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void view()}
          loading={state.kind === 'busy' && state.action === 'view'}
          disabled={state.kind === 'busy'}
          aria-label={`View ${subject}${viewable ? '' : ' (Word document: downloads)'}`}
        >
          View
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void save()}
          loading={state.kind === 'busy' && state.action === 'download'}
          disabled={state.kind === 'busy'}
          aria-label={`Download ${subject}`}
        >
          Download
        </Button>
      </div>
      <p aria-live="polite" className="text-xs">
        {state.kind === 'failed' && <span className="mt-1 block max-w-56 font-medium text-red-700">{state.message}</span>}
      </p>
    </div>
  )
}

type Dialog = 'none' | 'kpis' | 'columns'

export function ServicesSalesPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const userId = auth.user?.id ?? 'anonymous'
  const layout = useKpiLayout(userId)
  const [hidden, setHidden] = useHiddenColumns(userId)
  const [dialog, setDialog] = useState<Dialog>('none')
  const [exportError, setExportError] = useState<string | null>(null)

  // Every month and year at first: the page opens on all services, not on the current month.
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [clientId, setClientId] = useState('')
  const [salesEngineerId, setSalesEngineerId] = useState('')
  const [systemTypeId, setSystemTypeId] = useState('')
  const [frequency, setFrequency] = useState('')
  const [month, setMonth] = useState('')
  const [year, setYear] = useState('')
  const [serviceStatus, setServiceStatus] = useState('')
  const [quoteSubmission, setQuoteSubmission] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const canEdit = auth.can('SERVICES_SALES', 'EDIT')
  const canExport = auth.can('SERVICES_SALES', 'EXPORT')

  // One set of filters for the rows, the cards and the downloads.
  const filters = { search, clientId, salesEngineerId, systemTypeId, frequency, month, year, serviceStatus, quoteSubmission }
  const options = useQuery({ queryKey: ['services-sales', 'options'], queryFn: () => api.get<ServicesSalesOptions>('/services-sales/options') })
  const sales = useQuery({
    queryKey: ['services-sales', 'list', { ...filters, page }],
    queryFn: () => api.get<ServicesSalesList>(`/services-sales${queryString({ ...filters, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  })

  const change = (setter: (value: string) => void) => (value: string) => {
    setter(value)
    setPage(1)
  }
  const filtered = Object.values(filters).some((value) => value !== '') || searchInput !== ''
  const resetFilters = () => {
    setSearchInput('')
    setSearch('')
    setClientId('')
    setSalesEngineerId('')
    setSystemTypeId('')
    setFrequency('')
    setMonth('')
    setYear('')
    setServiceStatus('')
    setQuoteSubmission('')
    setPage(1)
  }
  // A save can change the cards and the visit's version, so the list and the other AMC pages read it again.
  const refresh = () => refreshOperationalData(queryClient)

  const data = sales.data
  // AMC Value is offered only when the API says this user may see contract values (it then sends them).
  const amcValueVisible = data?.amcValueVisible === true
  const available = COLUMN_IDS.filter((id) => (id !== 'amcValue' && id !== 'serviceValue') || amcValueVisible)
  const shown = (id: ColumnId) => available.includes(id) && !hidden.has(id)

  return (
    <>
      <PageHeader
        title="Service Sales"
        description="Track completed services and manually record quotation numbers."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setDialog('kpis')}>
              Customize KPIs
            </Button>
            <Button variant="secondary" onClick={() => setDialog('columns')}>
              Hide Columns{available.filter((id) => hidden.has(id)).length > 0 ? ` (${available.filter((id) => hidden.has(id)).length})` : ''}
            </Button>
            {canExport && (
              // The download covers every service that matches the filters, on every page, with the columns shown.
              <ExportButtons
                what="Service Sales"
                fileStem="service-sales"
                path={(format) => `/services-sales/export${queryString({ ...filters, hidden: [...hidden].filter((id) => !PAGE_ONLY_COLUMNS.has(id)).join(','), format })}`}
                onError={setExportError}
              />
            )}
          </div>
        }
      />

      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" role="group" aria-label="Service Sales figures">
        {layout.order.map((id, index) => (
          <StatTile
            key={id}
            label={layout.labels[id]}
            count={data ? KPI_STYLE[id].figure(data.kpis) : 0}
            hint={data ? undefined : 'Loading…'}
            icon={KPI_STYLE[id].icon}
            tone={KPI_STYLE[id].tone}
            edge={KPI_STYLE[id].edge}
            position={index}
          />
        ))}
      </div>
      <div className="-mt-3 mb-4">
        <KpiScopeNote cards={`${scheduledPeriod(month, year)}, with every filter applied.`} rows={`the same ${scheduledPeriod(month, year)}, with every filter applied.`} />
      </div>

      {data && data.kpis.quotationBeforeCompletion > 0 && (
        <div className="mb-4">
          <Alert tone="info">
            {data.kpis.quotationBeforeCompletion === 1 ? '1 service has' : `${data.kpis.quotationBeforeCompletion} services have`} a quotation number but{' '}
            {data.kpis.quotationBeforeCompletion === 1 ? 'is' : 'are'} not completed. {data.kpis.quotationBeforeCompletion === 1 ? 'It is' : 'They are'} counted as Not Completed and the
            number is kept.
          </Alert>
        </div>
      )}

      <Card>
        <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
            <StatusLegend />
            <p className="text-sm text-slate-500" aria-live="polite">
              {data ? (
                <>
                  <span className="font-semibold tabular-nums text-slate-800">{data.total}</span> {data.total === 1 ? 'service' : 'services'}
                </>
              ) : (
                'Loading…'
              )}
            </p>
          </div>
          <FilterPanel id="services-sales">
<div className="grid gap-4 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
            <Filter label="Search" className="sm:col-span-2">
              {(id, className) => (
                <input
                  id={id}
                  type="search"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="AMC reference, client, system, report or quote no."
                  className={className}
                />
              )}
            </Filter>
            <Filter label="Client">
              {(id, className) => (
                <select id={id} value={clientId} onChange={(event) => change(setClientId)(event.target.value)} className={className}>
                  <option value="">All clients</option>
                  <OptionsNotice source={options} count={options.data?.clients.length ?? 0} empty="No clients with current AMC visits" />
                  {(options.data?.clients ?? []).map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="Service Engineer">
              {(id, className) => (
                <select id={id} value={salesEngineerId} onChange={(event) => change(setSalesEngineerId)(event.target.value)} className={className}>
                  <option value="">All service engineers</option>
                  <OptionsNotice source={options} count={options.data?.salesEngineers.length ?? 0} empty="No service engineers linked to current AMC visits" />
                  {(options.data?.salesEngineers ?? []).map((engineer) => (
                    <option key={engineer.id} value={engineer.id}>
                      {engineer.name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="System">
              {(id, className) => (
                <select id={id} value={systemTypeId} onChange={(event) => change(setSystemTypeId)(event.target.value)} className={className}>
                  <option value="">All systems</option>
                  <OptionsNotice source={options} count={options.data?.systemTypes.length ?? 0} empty="No system types linked to current AMC visits" />
                  {(options.data?.systemTypes ?? []).map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="Maintenance Frequency">
              {(id, className) => (
                <select id={id} value={frequency} onChange={(event) => change(setFrequency)(event.target.value)} className={className}>
                  <option value="">All frequencies</option>
                  <OptionsNotice source={options} count={options.data?.frequencies.length ?? 0} empty="No frequencies on current AMC visits" />
                  {(options.data?.frequencies ?? []).map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="Scheduled month">
              {(id, className) => (
                <select id={id} value={month} onChange={(event) => change(setMonth)(event.target.value)} className={className}>
                  <option value="">All months</option>
                  {MONTHS.map((name, index) => (
                    <option key={name} value={String(index + 1)}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="Scheduled year">
              {(id, className) => (
                <select id={id} value={year} onChange={(event) => change(setYear)(event.target.value)} className={className}>
                  <option value="">All years</option>
                  <OptionsNotice source={options} count={options.data?.years.length ?? 0} empty="No years with current AMC visits" />
                  {(options.data?.years ?? []).map((value) => (
                    <option key={value} value={String(value)}>
                      {value}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="Service Status">
              {(id, className) => (
                <select id={id} value={serviceStatus} onChange={(event) => change(setServiceStatus)(event.target.value)} className={className}>
                  <option value="">All statuses</option>
                  {SERVICE_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {SERVICE_STATUS_LABELS[value]}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="Quote">
              {(id, className) => (
                <select id={id} value={quoteSubmission} onChange={(event) => change(setQuoteSubmission)(event.target.value)} className={className}>
                  <option value="">All</option>
                  {QUOTE_SUBMISSION_FILTERS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <div className="flex items-stretch">
              <button
                type="button"
                disabled={!filtered}
                onClick={resetFilters}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border-[1.5px] border-[#1479BD] bg-white px-5 text-sm font-bold text-[#0b3b66] shadow-sm transition-all hover:-translate-y-px hover:bg-[#1479BD] hover:text-white hover:shadow-md disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-50 disabled:text-slate-400 disabled:shadow-none disabled:hover:translate-y-0 disabled:hover:bg-slate-50 disabled:hover:text-slate-400"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Reset Filters
              </button>
            </div>
          </div>
</FilterPanel>
        </div>

        {sales.isPending && <Spinner label="Loading services" />}

        {sales.isError && (
          <div className="p-4">
            <Alert>
              {errorMessage(sales.error)}{' '}
              <button type="button" className="font-medium underline" onClick={() => void sales.refetch()}>
                Try again
              </button>
            </Alert>
          </div>
        )}

        {data && data.items.length === 0 && (
          <EmptyState
            title="No services found"
            description={filtered ? 'No scheduled service matches these filters. Reset the filters to see every service.' : 'Services appear here when an AMC contract is activated and its schedule is generated.'}
            action={filtered ? <Button variant="secondary" onClick={resetFilters}>Reset Filters</Button> : undefined}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">Service Sales</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.snHead}>
                      #
                    </th>
                    <th scope="col" className={TABLE.th}>
                      AMC Reference
                    </th>
                    {COLUMN_IDS.filter(shown).map((id) => (
                      <th key={id} scope="col" className={cx(TABLE.th, (id === 'amcValue' || id === 'serviceValue') && 'text-right')}>
                        {COLUMN_LABELS[id]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((item, index) => (
                    <tr key={item.id} data-sales-status={item.salesStatus} className={cx(TABLE.row, STATUS_TONE[item.salesStatus].row)}>
                      <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                      <td className={`${TABLE.td} whitespace-nowrap font-mono text-sm font-semibold text-[#0b3b66]`}>{item.reference}</td>
                      {shown('client') && <td className={`${TABLE.td} ${TABLE.text} font-semibold text-slate-900`}>{item.client.name}</td>}
                      {shown('system') && (
                        <td className={`${TABLE.td} ${TABLE.text}`}>
                          {item.system.typeName ?? item.system.description}
                          {item.system.typeName && item.system.typeName !== item.system.description && <div className="text-xs text-slate-500">{item.system.description}</div>}
                        </td>
                      )}
                      {shown('frequency') && <td className={`${TABLE.td} whitespace-nowrap`}>{item.frequency.label}</td>}
                      {shown('service') && (
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          <span className="inline-block rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-800 ring-1 ring-inset ring-slate-200">{serviceCodeLabel(item.service)}</span>
                          {item.service.cycleNo && <div className="mt-0.5 text-xs text-slate-500">Year {item.service.cycleNo}</div>}
                        </td>
                      )}
                      {shown('dueDate') && (
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          <div className="font-medium text-slate-900">{MONTHS[Number(item.scheduledDate.slice(5, 7)) - 1]} {item.scheduledDate.slice(0, 4)}</div>
                          <div className="text-xs text-slate-500">Due {formatDate(item.scheduledDate)}</div>
                        </td>
                      )}
                      {shown('serviceStatus') && (
                        <td className={TABLE.td}>
                          <ServiceStatusPill item={item} />
                          {item.completedDate && <div className="mt-1 text-xs text-slate-500">{formatDate(item.completedDate)}</div>}
                        </td>
                      )}
                      {shown('serviceReportNo') && (
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          {item.serviceReportNo ? <span className="font-mono text-sm font-semibold text-slate-900">{item.serviceReportNo}</span> : <span className="text-slate-400" title="No service report number recorded">—<span className="sr-only">No service report number recorded</span></span>}
                        </td>
                      )}
                      {shown('serviceReport') && (
                        <td className={TABLE.td}>
                          <ServiceReportCell item={item} />
                        </td>
                      )}
                      {shown('quotation') && (
                        <td className={TABLE.td}>
                          <QuotationCell item={item} canEdit={canEdit} onSaved={refresh} />
                        </td>
                      )}
                      {shown('salesEngineer') && <td className={`${TABLE.td} ${TABLE.text}`}>{item.salesEngineer?.name ?? <span className="text-slate-400">—</span>}</td>}
                      {shown('amcValue') && (
                        <td className={`${TABLE.td} whitespace-nowrap text-right font-semibold tabular-nums text-slate-900`} title="AMC Value / Year of this service's contract period, OMR excluding VAT">
                          {item.amcValue ? formatMoney(item.amcValue) : <span className="text-slate-400">—</span>}
                        </td>
                      )}
                      {shown('serviceValue') && (
                        <td className={`${TABLE.td} whitespace-nowrap text-right font-semibold tabular-nums text-slate-900`} title="This service's value, OMR excluding VAT">
                          {item.serviceValue ? formatMoney(item.serviceValue) : <span className="text-slate-400" title="No value recorded for this service">—</span>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                {shown('amcValue') && data.amcValueTotal && (
                  <tfoot>
                    {/* PostgreSQL's sum over the unique contract periods of every matching service, on every page. */}
                    <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold text-slate-900">
                      <th scope="row" colSpan={2 + COLUMN_IDS.filter(shown).indexOf('amcValue')} className={`${TABLE.td} text-right`}>
                        Total AMC Value of matching contracts ({data.amcValueTotal.contracts} unique contract {data.amcValueTotal.contracts === 1 ? 'period' : 'periods'}, all pages)
                        <span className="block text-xs font-medium text-slate-500">
                          Each contract period counts once, however many of its services match; a renewal is its own period. Not an invoice value or a payment.
                        </span>
                      </th>
                      <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{formatMoney(data.amcValueTotal.total)}</td>
                      {/* Service values are not totalled here: the total is of contract periods. */}
                      {shown('serviceValue') && <td className={TABLE.td} />}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>

      {dialog === 'kpis' && (
        <CustomizeKpisDialog
          labels={layout.labels}
          order={layout.order}
          onResetLabels={layout.resetLabels}
          onResetOrder={layout.resetOrder}
          onSave={(labels, order) => {
            layout.setLabels(labels)
            layout.setOrder(order)
            setDialog('none')
          }}
          onClose={() => setDialog('none')}
        />
      )}
      {dialog === 'columns' && (
        <HideColumnsDialog
          hidden={hidden}
          available={available}
          onSave={(next) => {
            setHidden(next)
            setDialog('none')
          }}
          onClose={() => setDialog('none')}
        />
      )}
    </>
  )
}
