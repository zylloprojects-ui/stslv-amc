import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../../../lib/api'
import { queryString } from '../amcApi'
import { formatDate } from '../amcFormat'
import { amcReference, RENEWAL_WARNING_DAYS, type ExpiringContracts } from './calendarTypes'

// At most this many warnings are read; the panel says when there are more.
const LIMIT = 100

function when(daysLeft: number): string {
  if (daysLeft < 0) return `Validity ended ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago, still marked Active`
  if (daysLeft === 0) return 'Ends today'

  return `Ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
}

/**
 * Active contracts whose validity ends within 45 days, or has ended while they
 * are still marked Active, from the existing expiring-contracts report. Shown
 * only to a user who may view contracts (the report's own permission). Nothing
 * is changed: each warning links to the contract, where renewals are made.
 */
export function RenewalWarnings({ clientId }: { clientId: string }) {
  const expiring = useQuery({
    queryKey: ['amc', 'reports', 'expiring', RENEWAL_WARNING_DAYS],
    queryFn: () => api.get<ExpiringContracts>(`/amc/reports/expiring${queryString({ days: RENEWAL_WARNING_DAYS, pageSize: LIMIT })}`),
  })

  if (expiring.isError) {
    return (
      <p className="mb-4 rounded-md bg-slate-50 px-4 py-2 text-sm text-slate-600 ring-1 ring-inset ring-slate-200" role="status">
        Renewal warnings could not be loaded.
      </p>
    )
  }
  if (!expiring.data) return null

  // The report lists each contract once; the client filter narrows it like the rest of the page.
  const items = expiring.data.items.filter((item) => !clientId || item.client.id === clientId)

  if (items.length === 0) return null

  const more = clientId ? 0 : expiring.data.total - expiring.data.items.length

  return (
    <section aria-labelledby="renewal-warnings-title" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 sm:px-5">
      <h2 id="renewal-warnings-title" className="text-sm font-semibold text-amber-950">
        Renewal warnings: {items.length} contract{items.length === 1 ? '' : 's'} ending within {RENEWAL_WARNING_DAYS} days
      </h2>
      <ul className="mt-2 divide-y divide-amber-200">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 text-sm">
            <span className="min-w-0 text-amber-950">
              <strong className="font-semibold">{amcReference(item.id)}</strong> · {item.client.name} — {item.systemDescription}
              <span className={item.daysLeft < 0 ? 'block text-red-800' : 'block text-amber-900'}>
                Valid to {formatDate(item.validTo)} · {when(item.daysLeft)}
              </span>
            </span>
            <Link
              to={`/amc/contracts/${item.id}`}
              aria-label={`Open contract ${amcReference(item.id)}`}
              className="shrink-0 font-semibold text-[#0b3b66] underline-offset-2 hover:underline"
            >
              Open contract
            </Link>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="mt-1 text-xs text-amber-900">Showing the first {expiring.data.items.length}; {more} more are not listed here.</p>}
    </section>
  )
}
