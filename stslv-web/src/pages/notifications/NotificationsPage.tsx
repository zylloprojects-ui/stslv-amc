import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { LoadError } from '../../components/records'
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { ALERTS_QUERY_KEY, type AlertList } from './notificationTypes'

/**
 * Alerts worked out from the current records for the signed-in user (overdue
 * visits, contracts past validity, work waiting for an invoice). Marking an
 * alert read hides it from the unread count until its figure changes.
 */
export function NotificationsPage() {
  const queryClient = useQueryClient()
  const alerts = useQuery({ queryKey: ALERTS_QUERY_KEY, queryFn: () => api.get<AlertList>('/notifications'), retry: false })
  const save = (data: AlertList) => queryClient.setQueryData(ALERTS_QUERY_KEY, data)
  const markOne = useMutation({ mutationFn: (key: string) => api.post<AlertList>(`/notifications/${key}/read`), onSuccess: save })
  const markAll = useMutation({ mutationFn: () => api.post<AlertList>('/notifications/read-all'), onSuccess: save })

  const unavailable = alerts.error instanceof ApiError && alerts.error.code === 'FEATURE_UNAVAILABLE'
  const data = alerts.data

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Alerts from the current records, for the work your role covers. They update as the records change."
        actions={
          data &&
          data.unreadCount > 0 && (
            <Button variant="secondary" onClick={() => markAll.mutate()} loading={markAll.isPending}>
              Mark all as read
            </Button>
          )
        }
      />

      {(markOne.isError || markAll.isError) && (
        <div className="mb-4">
          <Alert>{errorMessage(markOne.error ?? markAll.error)}</Alert>
        </div>
      )}

      <Card>
        {alerts.isPending && <Spinner label="Loading notifications" />}
        {unavailable && (
          <div className="p-5">
            <Alert tone="info">Notifications need a database update that has not been applied to this database yet (migration 0073).</Alert>
          </div>
        )}
        {alerts.isError && !unavailable && <LoadError error={alerts.error} onRetry={() => void alerts.refetch()} />}
        {data && data.items.length === 0 && <EmptyState title="Nothing needs attention" description="There are no alerts for the work your role covers." />}
        {data && data.items.length > 0 && (
          <ul className="divide-y divide-slate-100" aria-label="Notifications">
            {data.items.map((item) => (
              <li key={item.key} className={cx('flex flex-wrap items-start justify-between gap-3 px-5 py-4', !item.isRead && 'bg-sky-50/50')}>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
                    {!item.isRead && <span className="inline-block h-2 w-2 rounded-full bg-[#1479BD]" aria-hidden="true" />}
                    {item.title}
                    <Badge tone={item.severity === 'warning' ? 'amber' : 'blue'}>{item.severity === 'warning' ? 'Needs attention' : 'For information'}</Badge>
                    {item.pinned && <Badge tone="slate">Stays visible until renewed</Badge>}
                    <span className="sr-only">{item.isRead ? '(read)' : '(unread)'}</span>
                  </p>
                  <p className="mt-1 text-sm text-slate-700">{item.message}</p>
                  {item.readAt && <p className="mt-1 text-xs text-slate-500">Read {formatDateTime(item.readAt)}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Link to={item.link} className="rounded-md px-3 py-1.5 text-sm font-medium text-blue-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
                    Open
                  </Link>
                  {!item.isRead && (
                    <Button size="sm" variant="secondary" onClick={() => markOne.mutate(item.key)} aria-label={`Mark "${item.title}" as read`}>
                      Mark as read
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
