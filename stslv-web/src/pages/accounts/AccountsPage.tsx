import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { KpiScopeNote } from '../../components/KpiScopeNote'
import { StatTile } from '../../components/StatTile'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, EmptyState, Modal, OptionsNotice, PageHeader, Spinner } from '../../components/ui'
import { scheduledPeriod } from '../../lib/scheduledPeriod'
import { api, errorMessage } from '../../lib/api'
import { cx, formatDate } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import { queryString } from '../amc/amcApi'
import { Filter, Pager } from '../amc/components'
import { SERVICE_STATUS_LABELS } from '../amc/serviceStatusTypes'
import { displayName, KPI_NAME_MAX, useKpiCustomization } from '../amcManagement/managementPreferences'
import { serviceCodeLabel } from '../masterStatus/masterStatusTypes'
import './accounts.css'
import { ACCOUNTS_PREFIX, COLUMN_IDS, COLUMN_LABELS, useHiddenColumns, type ColumnId } from './accountsPreferences'
import {
  ACCOUNTS_COLOURS,
  ACCOUNTS_COLOUR_LABELS,
  INVOICE_FILTERS,
  SERVICE_FILTERS,
  type AccountsColour,
  type AccountsItem,
  type AccountsKpis,
  type AccountsList,
  type AccountsOptions,
} from './accountsTypes'

const PAGE_SIZE = 50
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const PAYMENT_NOTE = 'Payment is not recorded in STSLV AMC. An invoice number is not a payment.'

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    {path}
  </svg>
)

/** Badge and legend colours of each row colour. Row tints are in accounts.css. */
const COLOUR_TONE: Record<AccountsColour, { pill: string; dot: string }> = {
  RED: { pill: 'bg-red-100 text-red-800 ring-red-200', dot: 'bg-red-600' },
  BLUE: { pill: 'bg-sky-100 text-[#0b3b66] ring-sky-200', dot: 'bg-[#1479BD]' },
  GREEN: { pill: 'bg-emerald-100 text-emerald-800 ring-emerald-200', dot: 'bg-emerald-600' },
}

interface KpiCard {
  id: string
  label: string
  /** A count, or null for the money card. */
  count: (kpis: AccountsKpis) => number | null
  hint: (kpis: AccountsKpis) => string | undefined
  icon: ReactNode
  tone: string
  edge: string
}

/** The five cards, in standard order. Every figure comes from the API over the applied filters. */
const KPI_CARDS: KpiCard[] = [
  {
    id: 'rows',
    label: 'Rows',
    count: (k) => k.rows,
    hint: () => 'Scheduled services',
    icon: icon(<><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" /></>),
    tone: 'from-[#0b3b66] to-[#1479BD]',
    edge: '#0b3b66',
  },
  {
    id: 'completed',
    label: 'Completed',
    count: (k) => k.completed,
    hint: () => 'Service completed',
    icon: icon(<path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />),
    tone: 'from-emerald-600 to-emerald-400',
    edge: '#16a34a',
  },
  {
    id: 'notCompleted',
    label: 'Not Completed',
    count: (k) => k.notCompleted,
    hint: () => 'Includes waiting for renewal',
    icon: icon(<><circle cx="12" cy="12" r="8" /><path d="M12 8v4.5l3 2" strokeLinecap="round" /></>),
    tone: 'from-red-600 to-red-400',
    edge: '#dc2626',
  },
  {
    id: 'invoiceFilled',
    label: 'Invoice No. Filled',
    count: (k) => k.invoiceFilled,
    hint: () => 'Invoice recorded, not proof of payment',
    icon: icon(<><path d="M7 3.5h7.5L18 7v13.5H7z" strokeLinejoin="round" /><path d="M10 11h5M10 14.5h5" strokeLinecap="round" /></>),
    tone: 'from-[#1479BD] to-sky-400',
    edge: '#1479BD',
  },
  {
    id: 'totalValue',
    label: 'Total Visit Value',
    count: () => null,
    hint: (k) => (k.valueMissing > 0 ? `${k.valueMissing} ${k.valueMissing === 1 ? 'service has' : 'services have'} no value set` : 'Scheduled visit values; VAT basis not confirmed'),
    icon: icon(<><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6.5 9.5v5M17.5 9.5v5" strokeLinecap="round" /></>),
    tone: 'from-[#0b3b66] to-[#1479BD]',
    edge: '#0b3b66',
  },
]
const KPI_DEFAULTS = KPI_CARDS.map((card) => card.id)

/** The money card: an amount, so it is shown as stored rather than counted up. */
function ValueTile({ name, kpis, card, position }: { name: string; kpis: AccountsKpis | undefined; card: KpiCard; position: number }) {
  return (
    <div
      className="contract-tile login-rise relative flex w-full items-center gap-3.5 overflow-hidden rounded-xl border bg-white py-4 pl-5 pr-4 shadow-sm"
      style={{ animationDelay: `${position * 70}ms`, borderColor: `${card.edge}40`, backgroundImage: `linear-gradient(135deg, ${card.edge}12, transparent 60%)` }}
    >
      <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: card.edge }} aria-hidden="true" />
      <span className={cx('flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md', card.tone)}>{card.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-600">{name}</span>
        <span className="mt-0.5 block truncate text-2xl font-bold leading-tight tabular-nums tracking-tight text-[#0b3b66]">{kpis ? formatMoney(kpis.totalValue) : '—'}</span>
        <span className={cx('mt-1.5 block text-xs font-medium', kpis && kpis.valueMissing > 0 ? 'text-amber-700' : 'text-slate-500')}>{kpis ? card.hint(kpis) : 'Loading…'}</span>
      </span>
    </div>
  )
}

/** The five KPI cards. The user may rename and reorder them; both are remembered per user in this browser. */
function KpiCards({ userId, kpis }: { userId: string; kpis: AccountsKpis | undefined }) {
  const [customizing, setCustomizing] = useState(false)
  const prefs = useKpiCustomization(userId, 'kpis', KPI_DEFAULTS, ACCOUNTS_PREFIX)
  const cards = prefs.order.map((id) => KPI_CARDS.find((card) => card.id === id)).filter((card): card is KpiCard => card !== undefined)

  const move = (index: number, by: -1 | 1) => {
    const a = cards[index]?.id
    const b = cards[index + by]?.id

    if (!a || !b) return
    prefs.setOrder(prefs.order.map((id) => (id === a ? b : id === b ? a : id)))
  }

  return (
    <section aria-label="Accounts figures" className="mb-4">
      <div className="mb-2 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" size="sm" aria-pressed={customizing} aria-label="Customize KPI cards" onClick={() => setCustomizing(!customizing)}>
          {customizing ? 'Done' : 'Customize'}
        </Button>
        <Button variant="secondary" size="sm" onClick={prefs.resetNames} disabled={!prefs.namesChanged}>
          Reset KPI Names
        </Button>
        <Button variant="secondary" size="sm" onClick={prefs.resetOrder} disabled={!prefs.orderChanged}>
          Reset KPI Order
        </Button>
      </div>
      {customizing && (
        <p className="mb-2 text-xs text-slate-600">Rename a card or move it with the arrow buttons. A renamed card still shows the same figure. Names and order are remembered in this browser for your account.</p>
      )}
      {/* Every row is as tall as the tallest card, each card fills its cell, and contents start at the top, so icons, names and figures line up. */}
      <ul className="grid auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        {cards.map((card, index) => {
          const name = displayName(prefs.names, card.id, card.label)
          const count = kpis ? card.count(kpis) : 0

          return (
            <li
              key={card.id}
              data-kpi={card.id}
              title={name !== card.label ? `Standard name: ${card.label}` : undefined}
              className="flex flex-col [&>.contract-tile]:flex-1 [&>.contract-tile]:items-start"
            >
              {card.id === 'totalValue' ? (
                <ValueTile name={name} kpis={kpis} card={card} position={index} />
              ) : (
                <StatTile label={name} count={count ?? 0} hint={kpis ? card.hint(kpis) : 'Loading…'} icon={card.icon} tone={card.tone} edge={card.edge} position={index} />
              )}
              {customizing && (
                <div className="mt-2 space-y-1.5">
                  <label htmlFor={`accounts-kpi-${card.id}`} className="block text-xs font-medium text-slate-700">
                    Display name for {card.label}
                  </label>
                  <input
                    id={`accounts-kpi-${card.id}`}
                    type="text"
                    value={prefs.names[card.id] ?? ''}
                    placeholder={card.label}
                    maxLength={KPI_NAME_MAX}
                    onChange={(event) => prefs.rename(card.id, event.target.value)}
                    className="block w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-500"
                  />
                  <span className="flex justify-end gap-1">
                    <button type="button" className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs disabled:opacity-40" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${name} earlier`}>
                      ←
                    </button>
                    <button
                      type="button"
                      className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs disabled:opacity-40"
                      onClick={() => move(index, 1)}
                      disabled={index === cards.length - 1}
                      aria-label={`Move ${name} later`}
                    >
                      →
                    </button>
                  </span>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function ColourLegend() {
  return (
    <ul aria-label="Row colours" className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-700">
      {ACCOUNTS_COLOURS.map((colour) => (
        <li key={colour} className="flex items-center gap-2">
          <span className={cx('h-3 w-3 rounded-full', COLOUR_TONE[colour].dot)} aria-hidden="true" />
          {ACCOUNTS_COLOUR_LABELS[colour]}
        </li>
      ))}
    </ul>
  )
}

const Missing = ({ title }: { title: string }) => (
  <span className="text-slate-400" title={title}>
    —<span className="sr-only">{title}</span>
  </span>
)

/** Show or hide columns. AMC Reference and the actions always stay. */
function HideColumnsDialog({ hidden, onSave, onClose }: { hidden: ReadonlySet<ColumnId>; onSave: (hidden: ReadonlySet<ColumnId>) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Set<ColumnId>>(new Set(hidden))
  const toggle = (id: ColumnId) => {
    const next = new Set(draft)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setDraft(next)
  }

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
      <p className="mb-3 text-sm text-slate-600">AMC Reference and Actions are always shown. Downloads include only the columns shown here, plus the row colour.</p>
      <fieldset>
        <legend className="sr-only">Columns to show</legend>
        <ul className="grid gap-1 sm:grid-cols-2">
          {COLUMN_IDS.map((id) => (
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

interface Filters {
  search: string
  clientId: string
  salesEngineerId: string
  month: string
  year: string
  invoiceStatus: string
  serviceStatus: string
}

const NO_FILTERS: Filters = { search: '', clientId: '', salesEngineerId: '', month: '', year: '', invoiceStatus: '', serviceStatus: '' }

export function AccountsPage() {
  const auth = useAuth()
  const userId = auth.user?.id ?? 'anonymous'
  const [hidden, setHidden] = useHiddenColumns(userId)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  // The form holds what the user is choosing; the rows, cards and downloads follow only what was applied.
  const [draft, setDraft] = useState<Filters>(NO_FILTERS)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [page, setPage] = useState(1)

  const canExport = auth.can('ACCOUNTS', 'EXPORT')
  const canViewContract = auth.can('AMC_CONTRACTS', 'VIEW')
  const canRecordInvoice = auth.can('INVOICES', 'CREATE')

  const options = useQuery({ queryKey: ['accounts', 'options'], queryFn: () => api.get<AccountsOptions>('/accounts/options') })
  const accounts = useQuery({
    queryKey: ['accounts', 'list', { ...filters, page }],
    queryFn: () => api.get<AccountsList>(`/accounts${queryString({ ...filters, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  })

  const set = (key: keyof Filters) => (value: string) => setDraft({ ...draft, [key]: value })
  const apply = (event: FormEvent) => {
    event.preventDefault()
    setFilters({ ...draft, search: draft.search.trim() })
    setPage(1)
  }
  const reset = () => {
    setDraft(NO_FILTERS)
    setFilters(NO_FILTERS)
    setPage(1)
  }
  const filtered = Object.values(filters).some((value) => value !== '')
  const pendingChanges = JSON.stringify({ ...draft, search: draft.search.trim() }) !== JSON.stringify(filters)

  const data = accounts.data
  const shown = (id: ColumnId) => !hidden.has(id)
  const visible = COLUMN_IDS.filter(shown)

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Billing reconciliation of every scheduled AMC service: completion, service report and invoice number. Read only; invoices are recorded in Invoice Tracking."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setColumnsOpen(true)}>
              Hide Columns · {visible.length} of {COLUMN_IDS.length} shown
            </Button>
            {canExport && (
              // The download covers every service that matches the applied filters, on every page, with the columns shown.
              <ExportButtons
                what="Accounts"
                fileStem="accounts"
                path={(format) => `/accounts/export${queryString({ ...filters, hidden: [...hidden].join(','), format })}`}
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

      {/* Keyed by user: the saved names and order are read when the cards mount, so a change of user reads them again. */}
      <KpiCards key={userId} userId={userId} kpis={data?.kpis} />
      <div className="-mt-3 mb-4">
        <KpiScopeNote cards={`${scheduledPeriod(filters.month, filters.year)}, with every filter applied.`} rows={`the same ${scheduledPeriod(filters.month, filters.year)}, with every filter applied.`} />
      </div>

      <Card>
        <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
            <ColourLegend />
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
          <form className="grid gap-4 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4" onSubmit={apply} aria-label="Filters">
            <Filter label="Search" className="sm:col-span-2">
              {(id, className) => (
                <input
                  id={id}
                  type="search"
                  value={draft.search}
                  onChange={(event) => set('search')(event.target.value)}
                  placeholder="AMC reference, client, invoice no. or service report no."
                  className={className}
                />
              )}
            </Filter>
            <Filter label="Client">
              {(id, className) => (
                <select id={id} value={draft.clientId} onChange={(event) => set('clientId')(event.target.value)} className={className}>
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
            <Filter label="Sales Engineer">
              {(id, className) => (
                <select id={id} value={draft.salesEngineerId} onChange={(event) => set('salesEngineerId')(event.target.value)} className={className}>
                  <option value="">All sales engineers</option>
                  <OptionsNotice source={options} count={options.data?.salesEngineers.length ?? 0} empty="No sales engineers linked to current AMC visits" />
                  {(options.data?.salesEngineers ?? []).map((engineer) => (
                    <option key={engineer.id} value={engineer.id}>
                      {engineer.name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="Scheduled month">
              {(id, className) => (
                <select id={id} value={draft.month} onChange={(event) => set('month')(event.target.value)} className={className}>
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
                <select id={id} value={draft.year} onChange={(event) => set('year')(event.target.value)} className={className}>
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
            <Filter label="Invoice Status">
              {(id, className) => (
                <select id={id} value={draft.invoiceStatus} onChange={(event) => set('invoiceStatus')(event.target.value)} className={className} aria-describedby="accounts-payment-note">
                  <option value="">All</option>
                  {INVOICE_FILTERS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <Filter label="Service Status">
              {(id, className) => (
                <select id={id} value={draft.serviceStatus} onChange={(event) => set('serviceStatus')(event.target.value)} className={className}>
                  <option value="">All</option>
                  {SERVICE_FILTERS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
              <Button type="submit" variant={pendingChanges ? 'primary' : 'secondary'}>
                Apply
              </Button>
              <Button variant="secondary" disabled={!filtered && !pendingChanges} onClick={reset}>
                Reset
              </Button>
              {pendingChanges && <span className="text-xs text-slate-500">Filters changed. Select Apply to update the list.</span>}
              <span id="accounts-payment-note" className="basis-full text-xs text-slate-500">
                Paid / Unpaid cannot be filtered: {PAYMENT_NOTE}
              </span>
            </div>
          </form>
        </div>

        {accounts.isPending && <Spinner label="Loading services" />}

        {accounts.isError && (
          <div className="p-4">
            <Alert>
              {errorMessage(accounts.error)}{' '}
              <button type="button" className="font-medium underline" onClick={() => void accounts.refetch()}>
                Try again
              </button>
            </Alert>
          </div>
        )}

        {data && data.items.length === 0 && (
          <EmptyState
            title="No services found"
            description={filtered ? 'No scheduled service matches these filters. Reset the filters to see every service.' : 'Services appear here when an AMC contract is activated and its schedule is generated.'}
            action={filtered ? <Button variant="secondary" onClick={reset}>Reset</Button> : undefined}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <div className={cx(TABLE.wrapper, 'accounts-table')}>
              <table className={TABLE.table}>
                <caption className="sr-only">Accounts</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.snHead}>
                      #
                    </th>
                    <th scope="col" className={TABLE.th}>
                      AMC Reference
                    </th>
                    {visible.map((id) => (
                      <th key={id} scope="col" className={cx(TABLE.th, id === 'visitValue' && 'text-right')}>
                        {COLUMN_LABELS[id]}
                      </th>
                    ))}
                    <th scope="col" className={TABLE.th}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((item, index) => (
                    <Row
                      key={item.id}
                      item={item}
                      number={(data.page - 1) * data.pageSize + index + 1}
                      shown={shown}
                      canViewContract={canViewContract}
                      canRecordInvoice={canRecordInvoice}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>

      {columnsOpen && (
        <HideColumnsDialog
          hidden={hidden}
          onSave={(next) => {
            setHidden(next)
            setColumnsOpen(false)
          }}
          onClose={() => setColumnsOpen(false)}
        />
      )}
    </>
  )
}

const ACTION_LINK = 'inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1 text-sm font-semibold text-[#0b3b66] shadow-sm hover:border-[#1479BD] hover:text-[#1479BD]'

interface RowProps {
  item: AccountsItem
  number: number
  shown: (id: ColumnId) => boolean
  canViewContract: boolean
  canRecordInvoice: boolean
}

function Row({ item, number, shown, canViewContract, canRecordInvoice }: RowProps) {
  const tone = COLOUR_TONE[item.colour]

  return (
    <tr className={cx(TABLE.row, 'acc-row')} data-colour={item.colour}>
      <td className={TABLE.sn}>
        {number}
        <span className="sr-only">, {ACCOUNTS_COLOUR_LABELS[item.colour]}</span>
      </td>
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
      {shown('scheduledMonth') && (
        <td className={`${TABLE.td} whitespace-nowrap`}>
          <div className="font-medium text-slate-900">
            {MONTHS[Number(item.scheduledDate.slice(5, 7)) - 1]} {item.scheduledDate.slice(0, 4)}
          </div>
          <div className="text-xs text-slate-500">Due {formatDate(item.scheduledDate)}</div>
        </td>
      )}
      {shown('visitValue') && (
        <td className={`${TABLE.td} whitespace-nowrap text-right font-semibold tabular-nums text-slate-900`}>{item.visitValue === null ? <Missing title="No visit value set" /> : formatMoney(item.visitValue)}</td>
      )}
      {shown('serviceStatus') && (
        <td className={TABLE.td}>
          <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', tone.pill)}>
            <span className={cx('h-1.5 w-1.5 rounded-full', tone.dot)} aria-hidden="true" />
            {SERVICE_STATUS_LABELS[item.serviceStatus]}
          </span>
          {item.completedDate && <div className="mt-1 text-xs text-slate-500">{formatDate(item.completedDate)}</div>}
        </td>
      )}
      {shown('serviceReportNo') && (
        <td className={`${TABLE.td} whitespace-nowrap`}>
          {item.serviceReportNo ? <span className="font-mono text-sm font-semibold text-slate-900">{item.serviceReportNo}</span> : <Missing title="No service report number recorded" />}
        </td>
      )}
      {shown('invoiceNo') && (
        <td className={`${TABLE.td} whitespace-nowrap`}>
          {item.invoiceNumbers.length === 0 ? (
            <Missing title="No invoice recorded" />
          ) : (
            <ul>
              {item.invoiceNumbers.map((invoiceNumber) => (
                <li key={invoiceNumber} className="font-mono text-sm font-semibold text-slate-900">
                  {invoiceNumber}
                </li>
              ))}
            </ul>
          )}
        </td>
      )}
      {shown('payment') && (
        <td className={`${TABLE.td} whitespace-nowrap text-sm text-slate-500`} title={PAYMENT_NOTE}>
          Not available
        </td>
      )}
      {shown('salesEngineer') && <td className={`${TABLE.td} ${TABLE.text}`}>{item.salesEngineer?.name ?? <Missing title="No sales engineer" />}</td>}
      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
        <span className="inline-flex gap-2">
          {item.colour === 'BLUE' && canRecordInvoice && (
            // Invoices are recorded, with their date and amounts, only in Invoice Tracking; it opens with this visit ticked.
            <Link to={`/invoices?recordForVisit=${item.id}`} aria-label={`Record an invoice for ${item.reference} in Invoice Tracking`} className={ACTION_LINK}>
              Record invoice
            </Link>
          )}
          {canViewContract ? (
            <Link to={`/amc/contracts/${item.contract.id}`} aria-label={`View contract ${item.reference}`} className={ACTION_LINK}>
              View
            </Link>
          ) : (
            <span className="text-xs text-slate-400" title="Viewing contracts needs the AMC Contracts permission">
              No access
            </span>
          )}
        </span>
      </td>
    </tr>
  )
}
