import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/context'
import { Alert, Button, Card, EmptyState, PageHeader } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { formatTime } from '../lib/format'
import { MetricCard, type MetricState } from './dashboard/MetricCard'
import { METRIC_GROUPS, type DashboardSummary, type MetricDefinition } from './dashboard/metrics'

export function DashboardPage() {
  const auth = useAuth()
  const summary = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: () => api.get<DashboardSummary>('/dashboard/summary') })

  const stateOf = (metric: MetricDefinition): MetricState => {
    if (!metric.read) {
      return { kind: 'unavailable' }
    }
    if (summary.data) {
      return { kind: 'ready', reading: metric.read(summary.data) }
    }

    return summary.isError ? { kind: 'failed' } : { kind: 'loading' }
  }

  // A user sees a figure only where they can also open the module it belongs to.
  const groups = METRIC_GROUPS.map((group) => ({
    ...group,
    metrics: group.metrics.filter((metric) => auth.can(metric.module, 'VIEW')),
  })).filter((group) => group.metrics.length > 0)

  const pending = groups.flatMap((group) => group.metrics).filter((metric) => !metric.read).length

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Welcome, ${auth.user?.fullName ?? ''}.`}
        actions={
          <Button variant="secondary" loading={summary.isFetching} onClick={() => void summary.refetch()}>
            Refresh
          </Button>
        }
      />

      {summary.isError && (
        <div className="mb-6">
          <Alert>
            The dashboard figures could not be loaded. {errorMessage(summary.error)}{' '}
            <button type="button" className="font-medium underline" onClick={() => void summary.refetch()}>
              Try again
            </button>
          </Alert>
        </div>
      )}

      {groups.length === 0 && (
        <Card>
          <EmptyState
            title="No figures to show"
            description="Your role does not include any module that reports to the dashboard. If you need one, ask an administrator to update your role."
          />
        </Card>
      )}

      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`dashboard-${group.id}`} className="mb-8">
          <h2 id={`dashboard-${group.id}`} className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600">
            {group.title}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {group.metrics.map((metric) => (
              <MetricCard key={metric.id} metric={metric} state={stateOf(metric)} />
            ))}
          </div>
        </section>
      ))}

      {groups.length > 0 && (
        <p className="text-xs text-slate-600">
          {summary.data && !summary.isError && <>Figures as of {formatTime(summary.dataUpdatedAt)}. </>}
          {pending > 0 && (
            <>
              Figures marked “Not yet available” have no data source yet. They are left empty on purpose, so nothing here can be mistaken
              for real operational data.
            </>
          )}
        </p>
      )}
    </>
  )
}
