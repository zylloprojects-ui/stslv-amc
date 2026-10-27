import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExportButtons } from '../../components/ExportButtons'
import { FILTER_INPUT, FILTER_LABEL, LoadError, Money, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { cx, formatDate } from '../../lib/format'
import type { InvoiceStatus, PagedInvoices } from '../../lib/invoiceTypes'
import { queryString } from '../amc/amcApi'
import { InvoiceStatusBadge } from '../invoices/InvoicesTable'
import { useHiddenColumns } from './dashboardPreferences'

const PAGE_SIZE = 8

const COLUMNS = [
  { id: 'number', label: 'Invoice no.' },
  { id: 'client', label: 'Client' },
  { id: 'date', label: 'Invoice date' },
  { id: 'paid', label: 'Paid on' },
  { id: 'total', label: 'Total' },
  { id: 'status', label: 'Status' },
] as const

type ColumnId = (typeof COLUMNS)[number]['id']
const COLUMN_IDS = COLUMNS.map((column) => column.id)

/**
 * The latest invoices recorded in Invoice Tracking, newest invoice date first.
 * Read from the existing invoice list; nothing is generated here. Payment is
 * not recorded, so "Paid on" says so rather than showing a date.
 */
export function RecentInvoices({ userId, canExport }: { userId: string; canExport: boolean }) {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<InvoiceStatus | ''>('')
  const [page, setPage] = useState(1)
  const [hidden, setHidden] = useHiddenColumns(userId, 'recent-invoices', COLUMN_IDS)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const invoices = useQuery({
    queryKey: ['invoices', 'list', { search, status, page, pageSize: PAGE_SIZE }],
    queryFn: () => api.get<PagedInvoices>(`/invoices${queryString({ search, status, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  })

  const shown = (id: ColumnId) => !hidden.includes(id)
  const toggle = (id: ColumnId) => setHidden(hidden.includes(id) ? hidden.filter((column) => column !== id) : [...hidden, id])
  const visibleCount = COLUMNS.filter((column) => shown(column.id)).length

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-300 bg-slate-50 p-3">
        <div className="min-w-48 flex-1">
          <label htmlFor="recent-invoice-search" className={FILTER_LABEL}>
            Search
          </label>
          <input
            id="recent-invoice-search"
            type="search"
            className={FILTER_INPUT}
            placeholder="Invoice no. or client"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="recent-invoice-status" className={FILTER_LABEL}>
            Status
          </label>
          <select
            id="recent-invoice-status"
            className={FILTER_INPUT}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as InvoiceStatus | '')
              setPage(1)
            }}
          >
            <option value="">All</option>
            <option value="ISSUED">Issued</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
        <details className="relative">
          <summary className="inline-flex h-[38px] cursor-pointer list-none items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 text-sm font-semibold text-[#0b3b66] shadow-sm transition-colors hover:bg-sky-50 [&::-webkit-details-marker]:hidden">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-[#1479BD]" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M8 16v4" strokeLinecap="round" />
            </svg>
            Columns
          </summary>
          <fieldset className="absolute right-0 z-10 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
            <legend className="sr-only">Show or hide columns</legend>
            {COLUMNS.map((column) => (
              <label key={column.id} className="flex items-center gap-2 py-1 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={shown(column.id)}
                  // At least one column always stays visible.
                  disabled={shown(column.id) && visibleCount === 1}
                  onChange={() => toggle(column.id)}
                />
                {column.label}
              </label>
            ))}
          </fieldset>
        </details>
        {canExport && (
          <ExportButtons
            what="invoices"
            fileStem="invoice-tracking"
            size="sm"
            path={(format) => `/invoices/export${queryString({ format, search, status })}`}
            onError={setExportError}
          />
        )}
      </div>
      {!canExport && <p className="pb-2 text-xs text-slate-600">Excel and PDF exports need the Invoice Tracking export permission.</p>}
      {exportError && (
        <div className="pb-3">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}

      {invoices.isPending && <Spinner size="sm" label="Loading invoices" />}
      {invoices.isError && <LoadError error={invoices.error} onRetry={() => void invoices.refetch()} />}
      {invoices.data && invoices.data.items.length === 0 && (
        <p className="py-6 text-center text-sm text-slate-600">{search || status ? 'No invoice matches these filters.' : 'No invoices recorded yet.'}</p>
      )}
      {invoices.data && invoices.data.items.length > 0 && (
        <>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <caption className="sr-only">Recent invoices</caption>
              <thead>
                <tr>
                  {COLUMNS.filter((column) => shown(column.id)).map((column) => (
                    <th key={column.id} scope="col" className={cx(TABLE.th, column.id === 'total' && 'text-right')}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invoices.data.items.map((invoice) => (
                  <tr key={invoice.id} className={TABLE.row}>
                    {shown('number') && <td className={cx(TABLE.td, TABLE.unbroken, 'font-medium text-slate-900')}>{invoice.invoiceNumber}</td>}
                    {shown('client') && <td className={cx(TABLE.td, TABLE.text)}>{invoice.client.name}</td>}
                    {shown('date') && <td className={cx(TABLE.td, 'whitespace-nowrap')}>{formatDate(invoice.invoiceDate)}</td>}
                    {shown('paid') && <td className={cx(TABLE.td, 'whitespace-nowrap text-slate-500')}>Not tracked</td>}
                    {shown('total') && (
                      <td className={cx(TABLE.td, 'text-right')}>
                        <Money value={invoice.totalAmount} />
                      </td>
                    )}
                    {shown('status') && (
                      <td className={TABLE.td}>
                        <InvoiceStatusBadge status={invoice.status} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={PAGE_SIZE} shown={invoices.data.items.length} total={invoices.data.total} onPage={setPage}>
            <Link to="/invoices" className="text-sm font-medium text-[#1479BD] hover:underline">
              Open Invoice Tracking →
            </Link>
          </Pager>
        </>
      )}
      <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-inset ring-slate-200">Totals include VAT as entered from the Zoho invoice. Payment is not recorded in STSLV AMC.</p>
    </div>
  )
}
