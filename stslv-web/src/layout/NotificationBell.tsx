import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { ALERTS_QUERY_KEY, type AlertList } from '../pages/notifications/notificationTypes'

// Refreshed every few minutes while the application is open; nothing is pushed from the server.
const REFRESH_MS = 3 * 60 * 1000

/** The header bell: opens Notifications and shows how many alerts are unread. Hidden when alerts are unavailable. */
export function NotificationBell() {
  const alerts = useQuery({
    queryKey: ALERTS_QUERY_KEY,
    queryFn: () => api.get<AlertList>('/notifications'),
    refetchInterval: REFRESH_MS,
    retry: false,
  })

  if (!alerts.data) {
    return null
  }

  const unread = alerts.data.unreadCount
  const label = unread === 0 ? 'Notifications, none unread' : `Notifications, ${unread} unread`

  return (
    <Link to="/notifications" aria-label={label} title="Notifications" className="relative shrink-0 rounded-full p-2 text-slate-600 transition-colors hover:bg-sky-50">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <path d="M6 9.5a6 6 0 1 1 12 0c0 4.5 1.8 6 1.8 6H4.2S6 14 6 9.5ZM10 19a2 2 0 0 0 4 0" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white" aria-hidden="true">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  )
}
