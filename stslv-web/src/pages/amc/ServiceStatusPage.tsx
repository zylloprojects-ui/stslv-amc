import { refreshOperationalData } from '../../lib/refreshOperationalData'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { isAdmin } from '../../auth/roles'
import { ExportButtons } from '../../components/ExportButtons'
import { KpiScopeNote } from '../../components/KpiScopeNote'
import { StatTile } from '../../components/StatTile'
import { TABLE } from '../../components/table'
import { ServiceAcknowledgementIndicator } from '../invoiceAcknowledgements/ServiceAcknowledgement'
import { Alert, Button, Card, EmptyState, Modal, OptionsNotice, PageHeader, Spinner } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { cx } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import { queryString } from './amcApi'
import { formatDate, todayIso } from './amcFormat'
import { Filter, FilterPanel, Pager } from './components'
import { ServiceDetailsDialog } from './ServiceDetailsDialog'
import { ServiceReportCell, type ServiceReportCellHandle } from './ServiceReportCell'
import { HideColumnsDialog, KpiCustomizeDialog } from './ServiceStatusDialogs'
import { useHiddenServiceColumns, useKpiLayout, type KpiId } from './serviceStatusPreferences'
import { VisitActionsDialog } from './VisitActionsDialog'
import {
  MONTH_NAMES,
  SERVICE_STATUSES,
  SERVICE_REPORT_REQUIRED_MESSAGE,
  SERVICE_STATUS_LABELS,
  serviceLabel,
  type ServiceReport,
  type ServiceStatus,
  type ServiceStatusItem,
  type ServiceStatusList,
  type ServiceStatusOptions,
} from './serviceStatusTypes'
import './serviceStatus.css'

const PAGE_SIZE = 50
const REPORT_NUMBER_MAX = 50
/** The API's limit for the manual Sales Engineer Name (database update 0110). */
const ENGINEER_NAME_MAX = 120

// --- Status colours of the badges and the legend. Row colours are in serviceStatus.css,
// keyed on the row's data-status, so they hold on odd and even rows alike. ---
const STATUS_STYLE: Record<ServiceStatus, { badge: string; dot: string }> = {
  COMPLETED: { badge: 'bg-green-50 text-green-800 ring-green-600/25', dot: 'bg-green-600' },
  NOT_COMPLETED: { badge: 'bg-blue-50 text-blue-800 ring-blue-600/25', dot: 'bg-[#1479BD]' },
  WAITING_FOR_RENEWAL: { badge: 'bg-red-50 text-red-800 ring-red-600/25', dot: 'bg-red-600' },
}

function StatusBadge({ status }: { status: ServiceStatus }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset', STATUS_STYLE[status].badge)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', STATUS_STYLE[status].dot)} aria-hidden="true" />
      {SERVICE_STATUS_LABELS[status]}
    </span>
  )
}

function Legend() {
  return (
    <ul aria-label="Status colours" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
      {SERVICE_STATUSES.map((status) => (
        <li key={status} className="flex items-center gap-1.5">
          <span className={cx('h-3 w-3 rounded-sm', STATUS_STYLE[status].dot)} aria-hidden="true" />
          {SERVICE_STATUS_LABELS[status]}
        </li>
      ))}
    </ul>
  )
}

// --- KPI cards ---------------------------------------------------------------
const icon = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    {path}
  </svg>
)

const KPI_LOOK: Record<KpiId, { tone: string; edge: string; icon: ReactNode; hint: string; status: ServiceStatus | '' }> = {
  total: {
    tone: 'from-[#1479BD] to-[#4aa3df]',
    edge: '#1479BD',
    icon: icon(<><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" /></>),
    hint: 'Scheduled services matching the filters',
    status: '',
  },
  completed: {
    tone: 'from-emerald-600 to-emerald-400',
    edge: '#16a34a',
    icon: icon(<path d="m5 12.5 4.2 4.2L19 7" strokeLinecap="round" strokeLinejoin="round" />),
    hint: 'Visits marked completed',
    status: 'COMPLETED',
  },
  notCompleted: {
    tone: 'from-sky-600 to-sky-400',
    edge: '#0284c7',
    icon: icon(<><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" strokeLinecap="round" /></>),
    hint: 'Scheduled, in progress or postponed',
    status: 'NOT_COMPLETED',
  },
  waitingForRenewal: {
    tone: 'from-rose-600 to-rose-400',
    edge: '#dc2626',
    icon: icon(<><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" strokeLinecap="round" /><path d="M18 3v4h-4M6 21v-4h4" strokeLinecap="round" strokeLinejoin="round" /></>),
    hint: 'Not completed; contract ended without renewal',
    status: 'WAITING_FOR_RENEWAL',
  },
}

// --- Columns -------------------------------------------------------------------
const COLUMNS = [
  { key: 'client', label: 'Client' },
  { key: 'system', label: 'System' },
  { key: 'frequency', label: 'Frequency' },
  { key: 'service', label: 'Service' },
  // The linked contract's AMC Value / Year: offered only to users who may see contract values (AMC Contracts: View).
  { key: 'amcValue', label: 'AMC Value (OMR)' },
  // This service's own value (2026-11-11): visit_amount, the same value Master AMC Status shows (its share of the
  // billing basis, or the manual Cost per Visit), never the contract's full value. Same access as AMC Value.
  { key: 'serviceValue', label: 'Service Value (OMR)' },
  { key: 'due', label: 'Scheduled Month / Due Date' },
  { key: 'status', label: 'Service Status' },
  // Separate from the execution status (2026-11-11): Yes / No / Not Applicable for the service's invoice. Offered only
  // to users who may view Invoice Acknowledgements.
  { key: 'acknowledgement', label: 'Invoice Acknowledgement' },
  { key: 'engineer', label: 'Sales Engineer' },
  { key: 'report', label: 'Service Report No.' },
  // Typed by hand beside the report number (database update 0110); not the contract's Sales Engineer link.
  { key: 'engineerName', label: 'Sales Engineer Name' },
  { key: 'serviceReport', label: 'Service Report' },
] as const
type ColumnKey = (typeof COLUMNS)[number]['key']
const COLUMN_KEYS = COLUMNS.map((column) => column.key)

// --- One editable row ----------------------------------------------------------
// The completion date is not asked for: the API records it on completion (today) and keeps it.
interface Draft {
  status: ServiceStatus
  reportNumber: string
  salesEngineerName: string
}

const draftOf = (item: ServiceStatusItem): Draft => ({
  status: item.serviceStatus,
  reportNumber: item.reportNumber ?? '',
  salesEngineerName: item.salesEngineerName ?? '',
})

/** The API's minimum length of an override reason. */
const OVERRIDE_REASON_MIN = 5
const REPORT_NUMBER_LOCKED_HINT = 'Locked: this service is Paid (an Invoice No. is entered). Only an administrator can change the report number, with a reason.'

const LockIcon = () => (
  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
    <path d="M7 9V6.5a3 3 0 0 1 6 0V9" strokeLinecap="round" />
  </svg>
)

interface RowProps {
  item: ServiceStatusItem
  number: number
  shown: (key: ColumnKey) => boolean
  canSave: boolean
  /** Super Admin or Admin: may override a locked Service Report No. with a reason (the API checks the same). */
  canOverrideReportNumber: boolean
  canViewContracts: boolean
  reportNumberAvailable: boolean
  /** Database update 0110: the manual Sales Engineer Name can be saved. */
  engineerNameAvailable: boolean
  serviceReportsAvailable: boolean
  reportMaxMb: number
  onSaved: (item: ServiceStatusItem) => void
  /** A report was uploaded, replaced or removed: the visit itself is unchanged. */
  onReportChanged: (id: string, report: ServiceReport | null) => void
  /** Opens the read-only View of this service. */
  onView: () => void
  /** Opens Visit actions (start, postpone, cancel, work notes); absent without the execution permissions. */
  onActions?: (() => void) | undefined
}

function ServiceRow({
  item,
  number,
  shown,
  canSave,
  canOverrideReportNumber,
  canViewContracts,
  reportNumberAvailable,
  engineerNameAvailable,
  serviceReportsAvailable,
  reportMaxMb,
  onSaved,
  onReportChanged,
  onView,
  onActions,
}: RowProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(item))
  // Reason for an administrator's override of a locked Service Report No.; sent only with a change of that number.
  const [overrideReason, setOverrideReason] = useState('')
  const [base, setBase] = useState(item.updatedAt)
  const [problem, setProblem] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  // "Please upload service report.": shown when Completed is chosen (or saved) without a report.
  const [needsReport, setNeedsReport] = useState(false)
  const [highlightReport, setHighlightReport] = useState(false)
  const reportCell = useRef<ServiceReportCellHandle>(null)

  const statusChanged = draft.status !== item.serviceStatus
  const reportChanged = reportNumberAvailable && draft.reportNumber.trim() !== (item.reportNumber ?? '')
  const engineerNameChanged = engineerNameAvailable && draft.salesEngineerName.trim() !== (item.salesEngineerName ?? '')
  const dirty = statusChanged || reportChanged || engineerNameChanged
  // Paid and the lock switched on: read-only, except an administrator's override with a reason.
  const reportNumberLocked = item.reportNumberLocked === true
  const reportNumberEditable = canSave && reportNumberAvailable && (!reportNumberLocked || canOverrideReportNumber)
  const needsOverrideReason = reportNumberLocked && reportChanged

  // A newer copy of this visit arrived (after a save here or elsewhere): take it, unless the user has unsaved edits.
  if (item.updatedAt !== base && !dirty) {
    setBase(item.updatedAt)
    setDraft(draftOf(item))
  }

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<ServiceStatusItem>(`/amc/service-status/${item.id}`, body),
    onSuccess: (saved) => {
      // The saved record replaces the draft; edits are kept only when the save fails.
      setBase(saved.updatedAt)
      setDraft(draftOf(saved))
      setOverrideReason('')
      setSavedAt(saved.updatedAt)
      onSaved(saved)
    },
    onError: (error) => {
      // The API checks the report again (another user may have removed it): the same popup, and the draft is kept.
      if (error instanceof ApiError && error.code === 'SERVICE_REPORT_REQUIRED') return askForReport()
      setProblem(errorMessage(error))
    },
  })

  const askForReport = () => {
    setNeedsReport(true)
    setHighlightReport(true)
  }

  const save = () => {
    setProblem(null)
    setSavedAt(null)
    if (statusChanged && draft.status === 'COMPLETED' && !item.serviceReport) return askForReport()
    if (draft.reportNumber.trim().length > REPORT_NUMBER_MAX) return setProblem(`The report number can have at most ${REPORT_NUMBER_MAX} characters.`)
    if (draft.salesEngineerName.trim().length > ENGINEER_NAME_MAX) return setProblem(`The Sales Engineer Name can have at most ${ENGINEER_NAME_MAX} characters.`)
    if (needsOverrideReason && overrideReason.trim().length < OVERRIDE_REASON_MIN) {
      return setProblem(`This service is Paid, so its report number is locked. Enter the reason for the change (at least ${OVERRIDE_REASON_MIN} characters).`)
    }

    mutation.mutate({
      ...(statusChanged ? { status: draft.status } : {}),
      ...(reportChanged ? { reportNumber: draft.reportNumber.trim() } : {}),
      ...(needsOverrideReason ? { reportNumberOverrideReason: overrideReason.trim() } : {}),
      ...(engineerNameChanged ? { salesEngineerName: draft.salesEngineerName.trim() } : {}),
      expectedUpdatedAt: item.updatedAt,
    })
  }

  const chooseStatus = (status: ServiceStatus) => {
    setSavedAt(null)
    setProblem(null)
    // Completed needs this service's own uploaded report: without it the choice is not taken and the popup explains.
    if (status === 'COMPLETED' && !item.serviceReport) return askForReport()
    setDraft({ ...draft, status })
  }

  // Completed and saved: locked for everyone. Without the save permission the status is only shown.
  const statusLocked = !canSave || item.locked
  // Waiting for renewal is derived: it is offered only as the row's current state.
  const openChoice: ServiceStatus = item.serviceStatus === 'WAITING_FOR_RENEWAL' ? 'WAITING_FOR_RENEWAL' : 'NOT_COMPLETED'
  const label = `${item.reference} ${item.client.name} ${serviceLabel(item.service)}`
  const shownStatus = dirty ? draft.status : item.serviceStatus

  return (
    <tr className={cx(TABLE.row, 'ss-row')} data-status={shownStatus}>
      <td className={TABLE.sn}>{number}</td>
      <td className={cx(TABLE.td, 'whitespace-nowrap font-semibold')}>
        {canViewContracts ? (
          <Link to={`/amc/contracts/${item.contract.id}`} className="text-[#1479BD] hover:underline">
            {item.reference}
          </Link>
        ) : (
          item.reference
        )}
      </td>
      {shown('client') && (
        <td className={cx(TABLE.td, 'min-w-32 max-w-[13rem] font-medium text-slate-900')} title={item.client.name}>
          <span className="line-clamp-2 break-words">{item.client.name}</span>
        </td>
      )}
      {shown('system') && (
        <td className={cx(TABLE.td, 'min-w-32')}>
          {item.system.typeName ?? item.system.description}
          {item.system.typeName && item.system.typeName !== item.system.description && <div className="text-xs text-slate-500">{item.system.description}</div>}
        </td>
      )}
      {shown('frequency') && <td className={cx(TABLE.td, 'whitespace-nowrap')}>{item.frequency.label}</td>}
      {shown('service') && <td className={cx(TABLE.td, 'whitespace-nowrap')}>{serviceLabel(item.service)}</td>}
      {shown('amcValue') && (
        <td className={cx(TABLE.td, 'whitespace-nowrap text-right font-semibold tabular-nums text-slate-900')} title="AMC Value / Year of the contract, OMR excluding VAT">
          {item.amcValue === null || item.amcValue === undefined ? <span className="text-slate-400">—</span> : formatMoney(item.amcValue)}
        </td>
      )}
      {shown('serviceValue') && (
        <td className={cx(TABLE.td, 'whitespace-nowrap text-right font-semibold tabular-nums text-slate-900')} title="This service's value, OMR excluding VAT">
          {item.serviceValue === null || item.serviceValue === undefined ? (
            <span className="text-slate-400" title="No value recorded for this service">
              —<span className="sr-only">No value recorded</span>
            </span>
          ) : (
            formatMoney(item.serviceValue)
          )}
          {(item.serviceValue === null || item.serviceValue === undefined) && item.valueSourceMissing && (
            <div className="text-xs font-normal text-amber-700">No Billing Basis or Cost per Visit</div>
          )}
        </td>
      )}
      {shown('due') && (
        <td className={cx(TABLE.td, 'whitespace-nowrap')}>
          <div className="font-medium text-slate-900">{MONTH_NAMES[Number(item.scheduledDate.slice(5, 7)) - 1]} {item.scheduledDate.slice(0, 4)}</div>
          <div className={cx('text-xs', item.isOverdue && item.serviceStatus !== 'COMPLETED' ? 'font-semibold text-red-700' : 'text-slate-500')}>
            Due {formatDate(item.scheduledDate)}
            {item.isOverdue && item.serviceStatus !== 'COMPLETED' ? ' · overdue' : ''}
          </div>
        </td>
      )}
      {shown('status') && (
        <td className={cx(TABLE.td, 'min-w-40')}>
          {statusLocked ? (
            <span
              className="inline-flex items-center gap-1.5"
              title={item.locked ? 'Completed services are locked: the status cannot be changed.' : undefined}
              aria-label={item.locked ? `${SERVICE_STATUS_LABELS[item.serviceStatus]}, locked` : undefined}
            >
              <StatusBadge status={item.serviceStatus} />
              {item.locked && (
                <span className="text-slate-500">
                  <LockIcon />
                </span>
              )}
            </span>
          ) : (
            <select
              aria-label={`Service status of ${label}`}
              value={draft.status}
              onChange={(event) => chooseStatus(event.target.value as ServiceStatus)}
              disabled={mutation.isPending}
              className="block w-full min-w-[10rem] rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm shadow-sm"
            >
              <option value={openChoice}>{SERVICE_STATUS_LABELS[openChoice]}</option>
              <option value="COMPLETED">{SERVICE_STATUS_LABELS.COMPLETED}</option>
            </select>
          )}
        </td>
      )}
      {shown('acknowledgement') && (
        <td className={cx(TABLE.td, 'min-w-[9rem]')}>
          {item.acknowledgement ? <ServiceAcknowledgementIndicator acknowledgement={item.acknowledgement} /> : <span className="text-slate-400">—</span>}
        </td>
      )}
      {shown('engineer') && (
        <td className={cx(TABLE.td, 'max-w-[11rem]')} title={item.salesEngineer?.name}>
          {item.salesEngineer ? <span className="line-clamp-2 break-words">{item.salesEngineer.name}</span> : <span className="text-slate-400">—</span>}
        </td>
      )}
      {shown('report') && (
        <td className={cx(TABLE.td, 'min-w-32')}>
          {reportNumberEditable ? (
            <>
              <span className="flex items-center gap-1.5">
                <input
                  aria-label={`Service report number of ${label}`}
                  value={draft.reportNumber}
                  maxLength={REPORT_NUMBER_MAX}
                  onChange={(event) => {
                    setSavedAt(null)
                    setDraft({ ...draft, reportNumber: event.target.value })
                  }}
                  disabled={mutation.isPending}
                  placeholder="Report no."
                  title={reportNumberLocked ? REPORT_NUMBER_LOCKED_HINT : undefined}
                  className="block w-full min-w-[7.5rem] rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm shadow-sm placeholder:text-slate-400"
                />
                {reportNumberLocked && (
                  <span className="text-slate-500" title={REPORT_NUMBER_LOCKED_HINT}>
                    <LockIcon />
                  </span>
                )}
              </span>
              {needsOverrideReason && (
                <input
                  aria-label={`Reason for changing the locked report number of ${label}`}
                  value={overrideReason}
                  maxLength={500}
                  onChange={(event) => setOverrideReason(event.target.value)}
                  disabled={mutation.isPending}
                  placeholder="Reason for override (audited)"
                  className="mt-1 block w-full min-w-[9rem] rounded-lg border border-amber-400 bg-amber-50 px-2.5 py-1.5 text-xs shadow-sm placeholder:text-amber-800/70"
                />
              )}
            </>
          ) : reportNumberLocked ? (
            <span className="inline-flex items-center gap-1.5" title={REPORT_NUMBER_LOCKED_HINT} aria-label={`${item.reportNumber ?? 'No report number'}, locked`}>
              {item.reportNumber ?? <span className="text-slate-400">—</span>}
              <span className="text-slate-500">
                <LockIcon />
              </span>
            </span>
          ) : (
            (item.reportNumber ?? <span className="text-slate-400" title={reportNumberAvailable ? undefined : 'Available after database update 0077'}>—</span>)
          )}
        </td>
      )}
      {shown('engineerName') && (
        <td className={cx(TABLE.td, 'min-w-36')}>
          {canSave && engineerNameAvailable ? (
            <input
              aria-label={`Sales Engineer Name of ${label}`}
              value={draft.salesEngineerName}
              maxLength={ENGINEER_NAME_MAX}
              onChange={(event) => {
                setSavedAt(null)
                setDraft({ ...draft, salesEngineerName: event.target.value })
              }}
              disabled={mutation.isPending}
              placeholder="Engineer name"
              title={draft.salesEngineerName || undefined}
              className="block w-full min-w-[8rem] rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm shadow-sm placeholder:text-slate-400"
            />
          ) : item.salesEngineerName ? (
            <span className="line-clamp-2 break-words" title={item.salesEngineerName}>
              {item.salesEngineerName}
            </span>
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </td>
      )}
      {shown('serviceReport') && (
        <td className={TABLE.td}>
          <ServiceReportCell
            ref={reportCell}
            visitId={item.id}
            report={item.serviceReport}
            editable={canSave && serviceReportsAvailable && !item.locked}
            locked={item.locked}
            maxMb={reportMaxMb}
            label={label}
            highlight={highlightReport}
            onChanged={(report) => {
              setHighlightReport(false)
              onReportChanged(item.id, report)
            }}
          />
        </td>
      )}
      <td className={cx(TABLE.td, 'min-w-32 whitespace-nowrap text-right')}>
        <span className="inline-flex gap-1.5">
          <Button variant="secondary" size="sm" aria-label={`View ${label}`} title="View this service and its report." onClick={onView}>
            View
          </Button>
          {canSave && (
            <Button size="sm" disabled={!dirty} loading={mutation.isPending} aria-label={`Save ${label}`} onClick={save}>
              Save
            </Button>
          )}
          {canSave && onActions && (
              <Button
                variant="secondary"
                size="sm"
                disabled={dirty || mutation.isPending}
                title={dirty ? 'Save or undo the changes in this row first.' : 'Start, postpone or cancel this visit, or record work notes.'}
                aria-label={`Visit actions for ${label}`}
                onClick={onActions}
              >
                Actions
              </Button>
          )}
        </span>
        <div aria-live="polite" className="mt-1 max-w-48 whitespace-normal text-left text-xs">
          {problem && (
            <span role="alert" className="text-red-700">
              {problem}
            </span>
          )}
          {!problem && savedAt && !dirty && <span className="text-green-700">Saved</span>}
          {!problem && dirty && !mutation.isPending && <span className="text-amber-700">Unsaved changes</span>}
        </div>
      </td>
      {needsReport && (
        <Modal
          title="Service report required"
          onClose={() => {
            setNeedsReport(false)
            // Back on the row, at the highlighted Upload Report action.
            setTimeout(() => reportCell.current?.focus(), 0)
          }}
          footer={
            <>
              <Button variant="secondary" onClick={() => setNeedsReport(false)}>
                OK
              </Button>
              {shown('serviceReport') && serviceReportsAvailable && (
                <Button
                  onClick={() => {
                    setNeedsReport(false)
                    reportCell.current?.choose()
                  }}
                >
                  Upload Report
                </Button>
              )}
            </>
          }
        >
          <p role="alert" className="text-sm font-medium text-slate-800">
            {SERVICE_REPORT_REQUIRED_MESSAGE}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            {serviceReportsAvailable
              ? `${label} can be marked Completed once its service report (PDF, DOC or DOCX) is uploaded. Once saved as Completed, the status is locked.`
              : 'Service reports cannot be stored until the database is updated (0104), so services cannot be completed yet.'}
          </p>
        </Modal>
      )}
    </tr>
  )
}

// --- Page -------------------------------------------------------------------------
type Dialog = 'none' | 'kpis' | 'columns' | { visitId: string } | { viewId: string }

interface Filters {
  clientId: string
  salesEngineerId: string
  systemTypeId: string
  frequency: string
  month: string
  year: string
  serviceStatus: string
}

const defaultFilters = (): Filters => {
  const today = todayIso()

  return { clientId: '', salesEngineerId: '', systemTypeId: '', frequency: '', month: String(Number(today.slice(5, 7))), year: today.slice(0, 4), serviceStatus: '' }
}

export function ServiceStatusPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const userId = auth.user?.id ?? 'anonymous'

  const [filters, setFilters] = useState<Filters>(defaultFilters)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog>('none')
  const [exportError, setExportError] = useState<string | null>(null)
  const kpiLayout = useKpiLayout(userId)
  const [hidden, setHidden] = useHiddenServiceColumns<ColumnKey>(userId, COLUMN_KEYS)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const canSave = auth.can('AMC_EXECUTION', 'EDIT')
  // The override of a locked Service Report No. is reserved to administrators; the API checks the same.
  const canOverrideReportNumber = isAdmin(auth.user)
  // Visit actions read the visit from the execution API, so they also need its view permission.
  const canAct = canSave && auth.can('AMC_EXECUTION', 'VIEW')
  const canExport = auth.can('SERVICE_STATUS', 'EXPORT')
  const canViewContracts = auth.can('AMC_CONTRACTS', 'VIEW')

  const options = useQuery({ queryKey: ['amc', 'service-status', 'options'], queryFn: () => api.get<ServiceStatusOptions>('/amc/service-status/options') })
  const params = { ...filters, search }
  const list = useQuery({
    queryKey: ['amc', 'service-status', 'list', { ...params, page }],
    queryFn: () => api.get<ServiceStatusList>(`/amc/service-status${queryString({ ...params, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  })

  const change = (key: keyof Filters) => (value: string) => {
    setFilters((current) => ({ ...current, [key]: value }))
    setPage(1)
  }
  const resetFilters = () => {
    setFilters(defaultFilters())
    setSearchInput('')
    setSearch('')
    setPage(1)
  }

  const onSaved = (saved: ServiceStatusItem) => {
    // Show the saved row at once, then refresh every AMC view (schedule, calendar, cards) from the same records.
    queryClient.setQueriesData<ServiceStatusList>({ queryKey: ['amc', 'service-status', 'list'] }, (current) =>
      current ? { ...current, items: current.items.map((item) => (item.id === saved.id ? saved : item)) } : current,
    )
    void refreshOperationalData(queryClient)
  }

  // A report upload changes only the report: the row shows it at once, the visit (and its unsaved draft) is untouched.
  const onReportChanged = (id: string, report: ServiceReport | null) => {
    queryClient.setQueriesData<ServiceStatusList>({ queryKey: ['amc', 'service-status', 'list'] }, (current) =>
      current ? { ...current, items: current.items.map((item) => (item.id === id ? { ...item, serviceReport: report } : item)) } : current,
    )
    void queryClient.invalidateQueries({ queryKey: ['amc', 'service-status', 'item', id] })
  }

  const data = list.data
  const opts = options.data
  const reportNumberAvailable = data?.reportNumberAvailable ?? opts?.reportNumberAvailable ?? false
  const serviceReportsAvailable = data?.serviceReportsAvailable ?? opts?.serviceReportsAvailable ?? false
  const reportMaxMb = data?.serviceReportLimits.maxMb ?? 12
  const amcValueVisible = data?.amcValueVisible === true
  const engineerNameAvailable = data?.salesEngineerNameAvailable === true
  // Columns this user and database can have at all; the rest of the choice is the user's Hide Columns setting.
  const acknowledgementsVisible = data?.acknowledgementsVisible === true
  const availableColumns = COLUMNS.filter(
    (column) =>
      ((column.key !== 'amcValue' && column.key !== 'serviceValue') || amcValueVisible) &&
      (column.key !== 'acknowledgement' || acknowledgementsVisible) &&
      (column.key !== 'engineerName' || engineerNameAvailable),
  )
  const shown = (key: ColumnKey) => availableColumns.some((column) => column.key === key) && !hidden.has(key)
  const hiddenCount = availableColumns.filter((column) => hidden.has(column.key)).length
  const years = [...new Set([...(opts?.years ?? []), Number(todayIso().slice(0, 4))])].sort((a, b) => a - b)
  const period = filters.month && filters.year ? `${MONTH_NAMES[Number(filters.month) - 1]} ${filters.year}` : filters.year || (filters.month ? `${MONTH_NAMES[Number(filters.month) - 1]}, every year` : 'All dates')

  return (
    <>
      <PageHeader
        title="Service Status"
        description="Every scheduled AMC service, one row per visit: completion, service report and report number."
        actions={
          canExport ? (
            // Covers every service that matches the filters below, on every page, with the columns shown.
            <ExportButtons
              what="service status"
              fileStem="service-status"
              path={(format) => `/amc/service-status/export${queryString({ format, ...params, hidden: [...hidden].join(',') })}`}
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

      <section aria-label="Service figures" className="mb-5">
        <div className="mb-2 flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setDialog('kpis')}>
            Customize cards
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {kpiLayout.order.map((id, index) => {
            const look = KPI_LOOK[id]

            return (
              <StatTile
                key={id}
                label={kpiLayout.labelOf(id)}
                count={data?.kpis[id] ?? 0}
                hint={data ? look.hint : 'Loading…'}
                icon={look.icon}
                tone={look.tone}
                edge={look.edge}
                position={index}
                selected={look.status !== '' && filters.serviceStatus === look.status}
                onSelect={() => change('serviceStatus')(filters.serviceStatus === look.status ? '' : look.status)}
              />
            )
          })}
        </div>
        <KpiScopeNote
          cards={`services scheduled in ${period === 'All dates' ? 'any month (all dates)' : period}, with the filters below except Service Status.`}
          rows={`services scheduled in ${period === 'All dates' ? 'any month (all dates)' : period}, with all the filters below. Overdue services are marked in the Due Date column.`}
        />
      </section>

      <Card>
        <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-semibold text-slate-900">Services</h2>
              <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-[#0b3b66] ring-1 ring-inset ring-sky-200">{period}</span>
            </div>
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
          <FilterPanel id="service-status">
<div className="grid gap-4 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
            <Filter label="Search" className="sm:col-span-2">
              {(id, className) => (
                <input
                  id={id}
                  type="search"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="AMC reference, client, system or service, report no."
                  className={className}
                />
              )}
            </Filter>
            <Filter label="Client">
              {(id, className) => (
                <select id={id} value={filters.clientId} onChange={(event) => change('clientId')(event.target.value)} className={className}>
                  <option value="">All clients</option>
                  <OptionsNotice source={options} count={opts?.clients.length ?? 0} empty="No clients with current AMC visits" />
                  {(opts?.clients ?? []).map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            {opts?.salesEngineers !== null && (
              <Filter label="Sales Engineer">
                {(id, className) => (
                  <select id={id} value={filters.salesEngineerId} onChange={(event) => change('salesEngineerId')(event.target.value)} className={className}>
                    <option value="">All engineers</option>
                    <OptionsNotice source={options} count={opts?.salesEngineers?.length ?? 0} empty="No sales engineers linked to current AMC visits" />
                    {(opts?.salesEngineers ?? []).map((engineer) => (
                      <option key={engineer.id} value={engineer.id}>
                        {engineer.name}
                      </option>
                    ))}
                  </select>
                )}
              </Filter>
            )}
            {opts?.systemTypes !== null && (
              <Filter label="System">
                {(id, className) => (
                  <select id={id} value={filters.systemTypeId} onChange={(event) => change('systemTypeId')(event.target.value)} className={className}>
                    <option value="">All systems</option>
                    <OptionsNotice source={options} count={opts?.systemTypes?.length ?? 0} empty="No system types linked to current AMC visits" />
                    {(opts?.systemTypes ?? []).map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.name}
                      </option>
                    ))}
                  </select>
                )}
              </Filter>
            )}
            <Filter label="Maintenance Frequency">
              {(id, className) => (
                <select id={id} value={filters.frequency} onChange={(event) => change('frequency')(event.target.value)} className={className}>
                  <option value="">All frequencies</option>
                  <OptionsNotice source={options} count={opts?.frequencies.length ?? 0} empty="No frequencies on current AMC visits" />
                  {(opts?.frequencies ?? []).map((frequency) => (
                    <option key={frequency.code} value={frequency.code}>
                      {frequency.label}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="Scheduled month">
              {(id, className) => (
                <select id={id} value={filters.month} onChange={(event) => change('month')(event.target.value)} className={className}>
                  <option value="">All months</option>
                  {MONTH_NAMES.map((name, index) => (
                    <option key={name} value={String(index + 1)}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="Scheduled year">
              {(id, className) => (
                <select id={id} value={filters.year} onChange={(event) => change('year')(event.target.value)} className={className}>
                  <option value="">All years</option>
                  {years.map((year) => (
                    <option key={year} value={String(year)}>
                      {year}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="Service Status">
              {(id, className) => (
                <select id={id} value={filters.serviceStatus} onChange={(event) => change('serviceStatus')(event.target.value)} className={className}>
                  <option value="">All statuses</option>
                  {SERVICE_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {SERVICE_STATUS_LABELS[status]}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          </div>
</FilterPanel>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-4 sm:px-5">
            <Legend />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Hide Columns: ${availableColumns.length - hiddenCount} of ${availableColumns.length} columns shown`}
                onClick={() => setDialog('columns')}
              >
                Hide Columns
                <span className="font-normal text-slate-500">
                  · {availableColumns.length - hiddenCount} of {availableColumns.length} shown
                </span>
              </Button>
              <Button variant="secondary" size="sm" onClick={resetFilters}>
                Reset Filters
              </Button>
            </div>
          </div>
        </div>

        {options.isError && (
          <div className="px-4 pt-4">
            <Alert>The filter lists could not be loaded: {errorMessage(options.error)}</Alert>
          </div>
        )}

        {data && !data.serviceReportsAvailable && canSave && (
          <div className="px-4 pt-4">
            <Alert tone="info">Service reports cannot be uploaded yet: this database needs update 0104. Until then services cannot be marked Completed.</Alert>
          </div>
        )}

        {data && !data.reportNumberAvailable && canSave && (
          <div className="px-4 pt-4">
            <Alert tone="info">Service report numbers cannot be saved yet: this database needs update 0077. Statuses can be saved.</Alert>
          </div>
        )}

        {list.isPending && <Spinner label="Loading services" />}

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
            title={`No services found for ${period}`}
            description="Services appear here when an AMC contract is activated and its schedule is generated. Try another month or year, or reset the filters."
            action={
              <Button variant="secondary" onClick={resetFilters}>
                Reset Filters
              </Button>
            }
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <div className={cx(TABLE.wrapper, 'service-status-table')}>
              <table className={TABLE.table}>
                <caption className="sr-only">Service status for {period}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.snHead}>
                      #
                    </th>
                    <th scope="col" className={TABLE.th}>
                      AMC Reference
                    </th>
                    {COLUMNS.filter((column) => shown(column.key)).map((column) => (
                      <th key={column.key} scope="col" className={cx(TABLE.th, (column.key === 'amcValue' || column.key === 'serviceValue') && 'text-right')}>
                        {column.label}
                      </th>
                    ))}
                    <th scope="col" className={cx(TABLE.th, 'text-right')}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((item, index) => (
                    <ServiceRow
                      key={item.id}
                      item={item}
                      number={(data.page - 1) * data.pageSize + index + 1}
                      shown={shown}
                      canSave={canSave}
                      canOverrideReportNumber={canOverrideReportNumber}
                      canViewContracts={canViewContracts}
                      reportNumberAvailable={reportNumberAvailable}
                      engineerNameAvailable={engineerNameAvailable}
                      serviceReportsAvailable={serviceReportsAvailable}
                      reportMaxMb={reportMaxMb}
                      onSaved={onSaved}
                      onReportChanged={onReportChanged}
                      onView={() => setDialog({ viewId: item.id })}
                      onActions={canAct ? () => setDialog({ visitId: item.id }) : undefined}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>

      {dialog === 'kpis' && (
        <KpiCustomizeDialog
          order={kpiLayout.order}
          labelOf={kpiLayout.labelOf}
          onResetLabels={kpiLayout.resetLabels}
          onResetOrder={kpiLayout.resetOrder}
          onSave={(labels, order) => {
            kpiLayout.setLabels(labels)
            kpiLayout.setOrder(order)
            setDialog('none')
          }}
          onClose={() => setDialog('none')}
        />
      )}

      {typeof dialog === 'object' && 'viewId' in dialog && <ServiceDetailsDialog visitId={dialog.viewId} onClose={() => setDialog('none')} />}

      {typeof dialog === 'object' && 'visitId' in dialog && (
        <VisitActionsDialog visitId={dialog.visitId} onClose={() => setDialog('none')} onSaved={() => setDialog('none')} />
      )}

      {dialog === 'columns' && <HideColumnsDialog options={[...availableColumns]} hidden={hidden} onChange={setHidden} onClose={() => setDialog('none')} />}
    </>
  )
}
