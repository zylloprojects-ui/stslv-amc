// In-app alerts, as returned by /api/notifications (migration 0073).

export interface AppAlert {
  key: string
  severity: 'warning' | 'info'
  title: string
  message: string
  link: string
  count: number
  isRead: boolean
  readAt: string | null
}

export interface AlertList {
  items: AppAlert[]
  unreadCount: number
}

export const ALERTS_QUERY_KEY = ['notifications'] as const
