import type { QueryClient } from '@tanstack/react-query'

// Everything that shows contracts, visits or invoices. A change on one page must not
// leave another showing old figures until its cache runs out.
const KEYS = ['amc', 'dashboard', 'accounts', 'services-sales', 'invoices', 'projects', 'reports', 'notifications']

export function refreshOperationalData(queryClient: QueryClient): Promise<unknown> {
  return Promise.all(KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })))
}
