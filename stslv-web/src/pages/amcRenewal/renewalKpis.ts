import { formatCount } from '../../lib/format'
import type { KpiGroupDefinition } from '../amcManagement/managementKpis'
import type { RenewalQueue } from './renewalTypes'

// The four cards of the Renewal Queue. Each reads one figure the API returned;
// none is calculated here. A card links to the queue filtered on its state.

const link = (status: string) => ({ to: `/amc/renewal?status=${status}`, label: 'Show', module: 'AMC_CONTRACTS' as const })

export const RENEWAL_KPIS: KpiGroupDefinition<RenewalQueue> = {
  id: 'renewal-queue',
  title: 'Renewal KPIs',
  description: 'Counted over the search applied, whatever status is selected.',
  visible: (canView) => canView('AMC_CONTRACTS'),
  kpis: [
    {
      id: 'due',
      label: 'Due / Expired',
      icon: 'calendar',
      visible: (canView) => canView('AMC_CONTRACTS'),
      link: link('DUE'),
      read: ({ kpis, windowDays }) => ({
        kind: 'value',
        value: formatCount(kpis.due),
        detail: `Ending within ${windowDays} days or ended, no renewal yet`,
      }),
    },
    {
      id: 'under-approval',
      label: 'Under Client Approval',
      icon: 'pulse',
      visible: (canView) => canView('AMC_CONTRACTS'),
      link: link('UNDER_APPROVAL'),
      read: ({ kpis }) => ({ kind: 'value', value: formatCount(kpis.underApproval), detail: 'Renewal drafted, waiting for the client' }),
    },
    {
      id: 'renewed',
      label: 'Renewed',
      icon: 'contract',
      visible: (canView) => canView('AMC_CONTRACTS'),
      link: link('RENEWED'),
      read: ({ kpis }) => ({ kind: 'value', value: formatCount(kpis.renewed), detail: 'Renewal approved and active' }),
    },
    {
      id: 'cancelled',
      label: 'Cancelled',
      icon: 'shield',
      visible: (canView) => canView('AMC_CONTRACTS'),
      link: link('CANCELLED'),
      read: ({ kpis }) => ({ kind: 'value', value: formatCount(kpis.cancelled), detail: 'Renewal cancelled, none started since' }),
    },
  ],
}
