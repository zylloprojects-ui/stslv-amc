import type { ReactNode } from 'react'

/** Icon, colours and default subtitle for the page banner, chosen from the current address. */
export interface PageMeta {
  icon: ReactNode
  from: string
  to: string
  description: string
}

const ICON = {
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.2 2.7-5 6-5s6 1.8 6 5" strokeLinecap="round" />
      <path d="M16 5.2a3 3 0 0 1 0 5.6M18.5 14.4c1.6.7 2.5 2.1 2.5 4.6" strokeLinecap="round" />
    </>
  ),
  contract: (
    <>
      <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5Z" strokeLinejoin="round" />
      <path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5" strokeLinecap="round" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" />
    </>
  ),
  execution: (
    <>
      <rect x="5.5" y="4.5" width="13" height="16" rx="2.5" />
      <path d="M9.5 4.5h5v2h-5zM9 13l2.2 2.2L15 11" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  project: (
    <>
      <rect x="3.5" y="7" width="17" height="12.5" rx="2.5" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17" strokeLinecap="round" />
    </>
  ),
  cart: (
    <>
      <path d="M3.5 4.5h2.2l2 10h9.6l2-7.5H7" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9.5" cy="19" r="1.4" />
      <circle cx="16.5" cy="19" r="1.4" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" strokeLinecap="round" />
      <rect x="3.5" y="8" width="17" height="11.5" rx="2.5" />
      <circle cx="16.5" cy="13.75" r="1" fill="currentColor" />
    </>
  ),
  invoice: (
    <>
      <path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17Z" strokeLinejoin="round" />
      <path d="M9.5 8.5h5M9.5 12h5" strokeLinecap="round" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" strokeLinecap="round" />,
  shield: (
    <>
      <path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.2 7 9 4.2-1.8 7-4.8 7-9V6l-7-2.5Z" strokeLinejoin="round" />
      <path d="m9 12 2.2 2.2L15.2 10" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M4.6 7.5l1.9 1.1M17.5 15.4l1.9 1.1M4.6 16.5l1.9-1.1M17.5 8.6l1.9-1.1" strokeLinecap="round" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5" strokeLinecap="round" />
    </>
  ),
  page: <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5Z" strokeLinejoin="round" />,
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
    </>
  ),
}

// Matched against the start of the address, most specific first.
const PAGES: { prefix: string; meta: PageMeta }[] = [
  { prefix: '/dashboard', meta: { icon: ICON.dashboard, from: '#1B8AD3', to: '#5BAF48', description: 'Operational figures across AMC and projects' } },
  { prefix: '/clients', meta: { icon: ICON.users, from: '#1B8AD3', to: '#00A6C8', description: 'Client master records used by AMC contracts and projects' } },
  { prefix: '/amc/contracts', meta: { icon: ICON.contract, from: '#00A6C8', to: '#5BAF48', description: 'Contracts · Validity · Maintenance frequency · Cost per visit' } },
  { prefix: '/amc/schedule', meta: { icon: ICON.calendar, from: '#1B8AD3', to: '#F5C622', description: 'Scheduled maintenance visits generated from each contract' } },
  { prefix: '/amc/execution', meta: { icon: ICON.execution, from: '#5BAF48', to: '#00A6C8', description: 'Visit status · Completion · Ready for invoice' } },
  { prefix: '/projects', meta: { icon: ICON.project, from: '#FF8212', to: '#F5C622', description: 'Jobs · LPO details · Budget · Project status' } },
  { prefix: '/procurement', meta: { icon: ICON.cart, from: '#D1428C', to: '#FF8212', description: 'Suppliers · Quotations · Orders · Delivery status' } },
  { prefix: '/expenses', meta: { icon: ICON.wallet, from: '#00A6C8', to: '#F5C622', description: 'Project costs recorded against each job' } },
  { prefix: '/invoices', meta: { icon: ICON.invoice, from: '#1B8AD3', to: '#D1428C', description: 'Zoho invoice details tracked against visits and projects' } },
  { prefix: '/reports', meta: { icon: ICON.chart, from: '#7E6FAC', to: '#1B8AD3', description: 'Management reporting across AMC and projects' } },
  { prefix: '/admin/users', meta: { icon: ICON.shield, from: '#1B8AD3', to: '#5BAF48', description: 'Users · Roles · Permissions' } },
  { prefix: '/settings', meta: { icon: ICON.settings, from: '#7E6FAC', to: '#00A6C8', description: 'Application settings' } },
  { prefix: '/account', meta: { icon: ICON.person, from: '#1B8AD3', to: '#5BAF48', description: 'Your profile, role and sign-in details' } },
]

const FALLBACK: PageMeta = { icon: ICON.page, from: '#1B8AD3', to: '#00A6C8', description: '' }

export function pageMetaFor(pathname: string): PageMeta {
  return PAGES.find((page) => pathname === page.prefix || pathname.startsWith(page.prefix + '/'))?.meta ?? FALLBACK
}
