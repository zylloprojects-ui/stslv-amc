import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { Alert, Badge, Card, PageHeader } from '../components/ui'
import { api, errorMessage } from '../lib/api'

interface DashboardSummary {
  clients: { active: number; inactive: number }
}

// Metrics that depend on modules which are not built yet. They show no number
// at all, so nothing here can be mistaken for real operational data.
const PENDING_METRICS: { group: string; items: { label: string; reason: string }[] }[] = [
  {
    group: 'AMC',
    items: [
      { label: 'Active AMC Contracts', reason: 'the AMC Contracts module is not implemented yet' },
      { label: 'Visits Due', reason: 'the AMC Schedule module is not implemented yet' },
      { label: 'Ready for Invoice', reason: 'the AMC Execution and Invoice Tracking modules are not implemented yet' },
    ],
  },
  {
    group: 'Projects and finance',
    items: [
      { label: 'Active Projects', reason: 'the Projects module is not implemented yet' },
      { label: 'Project Costs', reason: 'the Expenses module is not implemented yet' },
      { label: 'Pending Invoices', reason: 'the Invoice Tracking module is not implemented yet' },
    ],
  },
]

export function DashboardPage() {
  const auth = useAuth()
  const summary = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: () => api.get<DashboardSummary>('/dashboard/summary') })

  return (
    <>
      <PageHeader title="Dashboard" description={`Welcome, ${auth.user?.fullName ?? ''}.`} />

      {summary.isError && (
        <div className="mb-6">
          <Alert>{errorMessage(summary.error)}</Alert>
        </div>
      )}

      <section aria-labelledby="live-heading" className="mb-8">
        <h2 id="live-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600">
          Master data
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card className="p-5">
            <p className="text-sm font-medium text-slate-600">Active Clients</p>
            <p className="mt-2 text-3xl font-semibold text-slate-900" aria-live="polite">
              {summary.isPending ? <span className="text-slate-300">…</span> : (summary.data?.clients.active ?? '—')}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {summary.data ? `${summary.data.clients.inactive} inactive` : ' '}
              {auth.can('CLIENTS', 'VIEW') && (
                <>
                  {' · '}
                  <Link to="/clients" className="font-medium text-blue-700 hover:underline">
                    View clients
                  </Link>
                </>
              )}
            </p>
          </Card>
        </div>
      </section>

      {PENDING_METRICS.map((group) => (
        <section key={group.group} aria-label={group.group} className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600">{group.group}</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {group.items.map((metric) => (
              <Card key={metric.label} className="border-dashed p-5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-slate-600">{metric.label}</p>
                  <Badge tone="amber">Not yet available</Badge>
                </div>
                <p className="mt-2 text-3xl font-semibold text-slate-300" aria-hidden="true">
                  —
                </p>
                <p className="mt-2 text-xs text-slate-500">No data: {metric.reason}.</p>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
