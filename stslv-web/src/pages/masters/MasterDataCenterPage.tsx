import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { Alert, Button, EmptyState, PageHeader } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import type { Module } from '../../lib/types'
import type { MasterCategoryKey, MasterSummary } from './masterTypes'

// Master Data Center: the hub of the five master lists. It only shows each
// list's active-record count and links to the list's own page; adding and
// editing records happens there.

interface Category {
  key: MasterCategoryKey
  label: string
  description: string
  path: string
  /** The page's own permission, so a card is offered only when its page can be opened. */
  module: Module
  icon: ReactNode
  /** Accent colour of the card. */
  edge: string
}

const svg = (paths: ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    {paths}
  </svg>
)

const MASTER_CATEGORIES: Category[] = [
  {
    key: 'clients',
    label: 'Clients',
    description: 'Client records used by AMC contracts and invoices.',
    path: '/clients',
    module: 'CLIENTS',
    edge: '#1B8AD3',
    icon: svg(
      <>
        <path d="M4 20.5V8.5l8-4.5 8 4.5v12" strokeLinejoin="round" />
        <path d="M9 20.5v-5h6v5M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01" strokeLinecap="round" />
      </>,
    ),
  },
  {
    key: 'sales-engineers',
    label: 'Sales Engineers',
    description: 'Engineers assigned to AMC contracts.',
    path: '/master-data/sales-engineers',
    module: 'SALES_ENGINEERS',
    edge: '#5BAF48',
    icon: svg(
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" strokeLinecap="round" />
      </>,
    ),
  },
  {
    key: 'system-types',
    label: 'System Types',
    description: 'The kinds of system an AMC contract covers.',
    path: '/master-data/system-types',
    module: 'SYSTEM_TYPES',
    edge: '#00A6C8',
    icon: svg(
      <>
        <rect x="3.5" y="4.5" width="17" height="11" rx="2" />
        <path d="M8.5 19.5h7M12 15.5v4" strokeLinecap="round" />
      </>,
    ),
  },
  {
    key: 'maintenance-frequencies',
    label: 'Maintenance Frequencies',
    description: 'How often visits are scheduled: labels and availability for new contracts.',
    path: '/master-data/maintenance-frequencies',
    module: 'MAINTENANCE_FREQUENCIES',
    edge: '#F5A623',
    icon: svg(
      <>
        <path d="M20 12a8 8 0 1 1-2.3-5.6" strokeLinecap="round" />
        <path d="M20 4.5v3.8h-3.8M12 8v4.2l2.8 1.8" strokeLinecap="round" strokeLinejoin="round" />
      </>,
    ),
  },
  {
    key: 'departments',
    label: 'Departments',
    description: 'The departments sales engineers belong to. Not user roles.',
    path: '/master-data/departments',
    module: 'DEPARTMENTS',
    edge: '#7E6FAC',
    icon: svg(
      <>
        <rect x="9" y="3.5" width="6" height="4.5" rx="1" />
        <rect x="3.5" y="16" width="6" height="4.5" rx="1" />
        <rect x="14.5" y="16" width="6" height="4.5" rx="1" />
        <path d="M12 8v4M6.5 16v-4h11v4" strokeLinejoin="round" />
      </>,
    ),
  },
]

type CountState = { kind: 'loading' } | { kind: 'error' } | { kind: 'update-required' } | { kind: 'count'; value: number }

function CountLine({ state }: { state: CountState }) {
  if (state.kind === 'loading') {
    return <span className="text-sm text-slate-500">Loading count…</span>
  }
  if (state.kind === 'error') {
    return <span className="text-sm text-slate-500">Count not available</span>
  }
  if (state.kind === 'update-required') {
    return <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">Database update required</span>
  }

  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-3xl font-bold leading-none tabular-nums tracking-tight text-[#0b3b66]">{state.value}</span>
      <span className="text-sm font-medium text-slate-500">active</span>
    </span>
  )
}

function CategoryCard({ category, state, position }: { category: Category; state: CountState; position: number }) {
  return (
    <Link
      to={category.path}
      aria-label={`${category.label}: ${state.kind === 'count' ? `${state.value} active` : state.kind === 'update-required' ? 'database update required' : 'open'}`}
      style={{ animationDelay: `${position * 70}ms`, borderColor: `${category.edge}40`, backgroundImage: `linear-gradient(135deg, ${category.edge}12, transparent 60%)` }}
      className="contract-tile login-rise group relative flex h-full flex-col gap-4 overflow-hidden rounded-xl border bg-white p-5 pl-6 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1479BD]"
    >
      <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: category.edge }} aria-hidden="true" />
      <span className="flex items-start gap-3.5">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white shadow-md transition-transform duration-300 group-hover:scale-110"
          style={{ backgroundColor: category.edge }}
        >
          {category.icon}
        </span>
        <span className="min-w-0">
          <span className="block text-base font-semibold text-slate-900">{category.label}</span>
          <span className="mt-0.5 block text-sm text-slate-600">{category.description}</span>
        </span>
      </span>
      <span className="mt-auto flex items-end justify-between gap-3">
        <CountLine state={state} />
        <span className="text-sm font-semibold text-[#1479BD] group-hover:underline" aria-hidden="true">
          Manage →
        </span>
      </span>
    </Link>
  )
}

/** Master Data Center: one card per master list, each with its live active-record count. */
export function MasterDataCenterPage() {
  const auth = useAuth()
  const categories = MASTER_CATEGORIES.filter((category) => auth.can(category.module, 'VIEW'))
  const summary = useQuery({
    queryKey: ['masters', 'summary'],
    queryFn: () => api.get<MasterSummary>('/masters/summary'),
    enabled: categories.length > 0,
    retry: false,
  })

  const stateOf = (key: MasterCategoryKey): CountState => {
    if (summary.isPending) return { kind: 'loading' }
    if (summary.isError) return { kind: 'error' }

    const entry = summary.data.categories.find((item) => item.key === key)

    if (!entry) return { kind: 'error' }
    if (!entry.available || entry.activeCount === null) return { kind: 'update-required' }

    return { kind: 'count', value: entry.activeCount }
  }

  return (
    <>
      <PageHeader title="Master Data Center" description="The reference lists used across AMC contracts. Records are deactivated, never deleted, so history stays intact." />

      {summary.isError && (
        <div className="mb-4">
          <Alert>
            <span className="flex flex-wrap items-center justify-between gap-3">
              <span>The record counts could not be loaded: {errorMessage(summary.error)}</span>
              <Button size="sm" variant="secondary" onClick={() => void summary.refetch()}>
                Try again
              </Button>
            </span>
          </Alert>
        </div>
      )}

      {categories.length === 0 ? (
        <EmptyState title="No master data is available for your role" description="Ask an administrator if you need access to clients or the master lists." />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Master data modules">
          {categories.map((category, index) => (
            <li key={category.key}>
              <CategoryCard category={category} state={stateOf(category.key)} position={index} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
