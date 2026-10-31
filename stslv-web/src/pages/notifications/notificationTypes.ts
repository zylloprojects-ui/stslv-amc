// In-app alerts, as returned by /api/notifications (migration 0073).

export interface AppAlert {
  key: string
  severity: 'warning' | 'info'
  title: string
  message: string
  /** Null when this user cannot open the page. */
  link: string | null
  count: number
  isRead: boolean
  readAt: string | null
  /** The renewal warning: listed for as long as it applies, read or not. Absent from an older API. */
  pinned?: boolean
}

export interface AlertList {
  items: AppAlert[]
  unreadCount: number
}

export const ALERTS_QUERY_KEY = ['notifications'] as const
