import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { Badge, Button, Card, PageHeader } from '../components/ui'
import { apiUrl } from '../lib/api'
import { DEPARTMENTS_ENABLED } from '../lib/features'
import { cx, initialsOf } from '../lib/format'
import { PALETTES, usePalette, useSidebarCollapsed, useTheme, type PaletteId } from '../lib/preferences'
import { ChangePasswordModal } from './account/ChangePasswordModal'
import { OrganizationPanel, type OrganizationSection } from './settings/OrganizationPanels'
import { UserOverview, type OverviewPart } from './settings/UserOverview'

interface HealthResponse {
  success: boolean
  database?: string
}

// The two health routes predate the { success, data } response format, so they are read directly.
async function fetchHealth(path: string): Promise<HealthResponse> {
  const response = await fetch(apiUrl(path), { headers: { Accept: 'application/json' } })
  const body = (await response.json().catch(() => null)) as HealthResponse | null

  if (!response.ok || !body?.success) {
    throw new Error('Unavailable')
  }

  return body
}

const stateOf = (query: { isPending: boolean; isError: boolean }) => (query.isPending ? 'checking' : query.isError ? 'down' : 'ok')

const svg = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    {path}
  </svg>
)

const ICONS = {
  profile: svg(
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5" strokeLinecap="round" />
    </>,
  ),
  preferences: svg(
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 2-2 0-1.3-.9-1.6-.9-2.7 0-1 .8-1.8 1.8-1.8H17a3.5 3.5 0 0 0 3.5-3.5C20.5 6.5 16.7 3.5 12 3.5Z" strokeLinejoin="round" />
      <circle cx="8" cy="11" r="1" />
      <circle cx="11" cy="7.5" r="1" />
      <circle cx="15.5" cy="8" r="1" />
    </>,
  ),
  security: svg(<path d="M14.5 9.5a4 4 0 1 0-3.7 4L13 15.5v2h2v2h2.5v-2.8l-4.2-4.2" strokeLinecap="round" strokeLinejoin="round" />),
  users: svg(
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.2 2.7-5 6-5s6 1.8 6 5" strokeLinecap="round" />
      <path d="M16 5.2a3 3 0 0 1 0 5.6M18.5 14.4c1.6.7 2.5 2.1 2.5 4.6" strokeLinecap="round" />
    </>,
  ),
  access: svg(
    <>
      <path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.2 7 9 4.2-1.8 7-4.8 7-9V6l-7-2.5Z" strokeLinejoin="round" />
      <path d="m9 12 2.2 2.2L15.2 10" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  ),
  activity: svg(<path d="M3 12h4l2.5-6 4 12 2.5-6H21" strokeLinecap="round" strokeLinejoin="round" />),
  status: svg(
    <>
      <rect x="3.5" y="4.5" width="17" height="6" rx="2" />
      <rect x="3.5" y="13.5" width="17" height="6" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" strokeLinecap="round" strokeWidth="2.4" />
    </>,
  ),
  business: svg(
    <>
      <rect x="3.5" y="7" width="17" height="12.5" rx="2.5" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17" strokeLinecap="round" />
    </>,
  ),
  mail: svg(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  ),
  moon: svg(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" strokeLinejoin="round" />),
  sun: svg(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" strokeLinecap="round" />
    </>,
  ),
  panel: svg(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </>,
  ),
  company: svg(
    <>
      <path d="M4.5 20.5v-13L12 4l7.5 3.5v13M9 20.5v-5h6v5M8 10h.01M12 10h.01M16 10h.01M8 13h.01M12 13h.01M16 13h.01" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  ),
  divisions: svg(
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>,
  ),
  departments: svg(
    <>
      <circle cx="12" cy="6" r="2.5" />
      <circle cx="5.5" cy="17.5" r="2.5" />
      <circle cx="18.5" cy="17.5" r="2.5" />
      <path d="M12 8.5v3.5M12 12H5.5v3M12 12h6.5v3" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  ),
  holidays: svg(
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4M12 13.5l1 2h2l-1.6 1.4.6 2.1-2-1.3-2 1.3.6-2.1L9 15.5h2l1-2Z" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  ),
  tax: svg(
    <>
      <path d="M18 6 6 18" strokeLinecap="round" />
      <circle cx="7.5" cy="7.5" r="2" />
      <circle cx="16.5" cy="16.5" r="2" />
    </>,
  ),
  logout: svg(<path d="M9 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H9M15 8l4 4-4 4M19 12H9" strokeLinecap="round" strokeLinejoin="round" />),
}

type SectionId = 'profile' | 'preferences' | 'security' | 'users' | 'access' | 'activity' | OrganizationSection | 'status' | 'business'

interface NavItem {
  id: SectionId
  label: string
  icon: ReactNode
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <Card className="p-5 sm:p-7">
      <h2 className="text-xl font-bold tracking-tight text-[#0b3b66]">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      <div className="mt-6">{children}</div>
    </Card>
  )
}

function ProfilePanel() {
  const auth = useAuth()
  const user = auth.user
  const [changing, setChanging] = useState(false)

  if (!user) {
    return null
  }

  const modules = new Set(user.permissions.map((permission) => permission.split(':')[0])).size

  return (
    <Card>
      {/* A cover in the brand blue, with the avatar resting on its lower edge. */}
      <div className="app-banner relative h-32 sm:h-36" aria-hidden="true" />
      <div className="relative z-10 px-5 pb-7 sm:px-8">
        <div className="-mt-12 flex flex-wrap items-end gap-x-6 gap-y-3 sm:-mt-14">
          <span
            className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#1479BD] to-[#4aa3df] text-4xl font-bold text-white shadow-xl shadow-sky-900/25 ring-[6px] ring-white sm:h-28 sm:w-28"
            aria-hidden="true"
          >
            {initialsOf(user.fullName)}
          </span>
          <div className="min-w-0 flex-1 pb-1">
            <h2 className="break-words text-2xl font-bold tracking-tight text-[#0b3b66]">{user.fullName}</h2>
            <p className="break-words text-sm text-slate-500">{user.email}</p>
          </div>
          <span className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            Active account
          </span>
        </div>

        <div className="mt-7 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{user.roles.length === 1 ? 'Role' : 'Roles'}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {user.roles.length === 0 ? (
                <Badge>No role assigned</Badge>
              ) : (
                user.roles.map((role) => (
                  <Badge key={role.id} tone="blue">
                    {role.name}
                  </Badge>
                ))
              )}
            </div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Modules enabled</p>
            <p className="mt-1 text-3xl font-bold leading-none tabular-nums text-[#0b3b66]">{modules}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Password</p>
            <button type="button" onClick={() => setChanging(true)} className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-[#1479BD] hover:underline">
              Change password
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="m7 4 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>

        <p className="mt-6 border-t border-slate-200 pt-5 text-xs text-slate-500">Your name, email and roles are read-only here. To change them, ask an administrator.</p>
      </div>
      {changing && <ChangePasswordModal onClose={() => setChanging(false)} />}
    </Card>
  )
}

const SWATCH: Record<PaletteId, string> = {
  ocean: 'linear-gradient(135deg, #06182c, #0b4a7a)',
  sky: 'linear-gradient(135deg, #ffffff, #cfe6f8)',
  mint: 'linear-gradient(135deg, #ffffff, #bfe7cf)',
  sand: 'linear-gradient(135deg, #fffdf8, #f9d9a3)',
  lavender: 'linear-gradient(135deg, #ffffff, #d6cbef)',
}

function Choice({ selected, onClick, children, label }: { selected: boolean; onClick: () => void; children: ReactNode; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onClick}
      className={cx(
        'group relative flex items-center gap-3 rounded-xl border bg-white p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md',
        selected ? 'border-[#1479BD] shadow-sm ring-2 ring-[#1479BD]/25' : 'border-slate-200 hover:border-sky-300',
      )}
    >
      {children}
      {selected && (
        <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-[#1479BD] text-white" aria-hidden="true">
          <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </button>
  )
}

function PreferencesPanel() {
  const [theme, , setTheme] = useTheme()
  const [palette, choosePalette] = usePalette()
  const [collapsed, , setCollapsed] = useSidebarCollapsed()

  return (
    <Panel title="Preferences" subtitle="How the application looks for you. These choices are kept in this browser only.">
      <div className="space-y-8">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Appearance</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Choice label="Light mode" selected={theme === 'light'} onClick={() => setTheme('light')}>
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 text-amber-600 ring-1 ring-amber-100">{ICONS.sun}</span>
              <span>
                <span className="block text-sm font-semibold text-slate-900">Light</span>
                <span className="block text-xs text-slate-500">Bright pages, easy in daylight</span>
              </span>
            </Choice>
            <Choice label="Dark mode" selected={theme === 'dark'} onClick={() => setTheme('dark')}>
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-800 text-sky-200">{ICONS.moon}</span>
              <span>
                <span className="block text-sm font-semibold text-slate-900">Dark</span>
                <span className="block text-xs text-slate-500">Dim pages, easier on the eyes at night</span>
              </span>
            </Choice>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-slate-900">Colour palette</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Colours of the sidebar and page headers.{theme === 'dark' && ' Dark mode is on, so palettes show when you switch back to light.'}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {PALETTES.map((item) => (
              <Choice key={item.id} label={`${item.name} palette`} selected={palette === item.id} onClick={() => choosePalette(item.id)}>
                <span className="h-10 w-10 shrink-0 rounded-lg shadow-inner ring-1 ring-slate-300/60" style={{ backgroundImage: SWATCH[item.id] }} />
                <span>
                  <span className="block text-sm font-semibold text-slate-900">{item.name}</span>
                  <span className="block text-xs text-slate-500">{item.note}</span>
                </span>
              </Choice>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-slate-900">Sidebar</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Choice label="Full sidebar" selected={!collapsed} onClick={() => setCollapsed(false)}>
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-50 text-[#1479BD] ring-1 ring-sky-100">{ICONS.panel}</span>
              <span>
                <span className="block text-sm font-semibold text-slate-900">Full</span>
                <span className="block text-xs text-slate-500">Icons and names</span>
              </span>
            </Choice>
            <Choice label="Narrow sidebar" selected={collapsed} onClick={() => setCollapsed(true)}>
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-50 text-[#1479BD] ring-1 ring-sky-100">{ICONS.panel}</span>
              <span>
                <span className="block text-sm font-semibold text-slate-900">Narrow</span>
                <span className="block text-xs text-slate-500">Icons only, more room for tables</span>
              </span>
            </Choice>
          </div>
        </div>
      </div>
    </Panel>
  )
}

function SecurityPanel() {
  const auth = useAuth()
  const [changing, setChanging] = useState(false)

  return (
    <Panel title="Security" subtitle="Keep your account safe.">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 p-4">
          <div className="flex items-start gap-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-[#1479BD] ring-1 ring-sky-100">{ICONS.security}</span>
            <div>
              <p className="text-sm font-semibold text-slate-900">Password</p>
              <p className="text-xs text-slate-500">Change it regularly, and never share it.</p>
            </div>
          </div>
          <Button onClick={() => setChanging(true)}>Change password</Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 p-4">
          <div className="flex items-start gap-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-[#1479BD] ring-1 ring-sky-100">{ICONS.logout}</span>
            <div>
              <p className="text-sm font-semibold text-slate-900">Signed in as {auth.user?.email}</p>
              <p className="text-xs text-slate-500">Sign out when you leave a shared computer.</p>
            </div>
          </div>
          <Button variant="secondary" onClick={auth.logout}>
            Sign out
          </Button>
        </div>
      </div>
      {changing && <ChangePasswordModal onClose={() => setChanging(false)} />}
    </Panel>
  )
}

function StatusLine({ label, state, detail }: { label: string; state: 'checking' | 'ok' | 'down'; detail?: string | undefined }) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div>
        <p className="text-sm font-semibold text-slate-900">{label}</p>
        {detail && <p className="text-xs text-slate-500">{detail}</p>}
      </div>
      {state === 'checking' && <Badge>Checking…</Badge>}
      {state === 'ok' && <Badge tone="green">Connected</Badge>}
      {state === 'down' && <Badge tone="amber">Unavailable</Badge>}
    </div>
  )
}

function StatusPanel() {
  const apiHealth = useQuery({ queryKey: ['health', 'api'], queryFn: () => fetchHealth('/api/health'), retry: false })
  const dbHealth = useQuery({ queryKey: ['health', 'database'], queryFn: () => fetchHealth('/api/health/database'), retry: false })

  return (
    <Panel title="System status" subtitle="Whether the parts of the system are reachable right now.">
      <div className="divide-y divide-slate-100">
        <StatusLine label="API" state={stateOf(apiHealth)} />
        <StatusLine label="Database" state={stateOf(dbHealth)} detail={dbHealth.data?.database ? `PostgreSQL database: ${dbHealth.data.database}` : undefined} />
      </div>
      <div className="mt-6 rounded-xl border border-sky-100 bg-sky-50/60 p-4">
        <p className="text-sm font-semibold text-[#0b3b66]">STSLEV AMC</p>
        <p className="text-xs text-slate-600">Smart Technical Service LLC · Operations Suite</p>
      </div>
    </Panel>
  )
}

function BusinessPanel() {
  const auth = useAuth()

  return (
    <Panel title="Business settings" subtitle="Rules the business has confirmed.">
      <p className="text-sm text-slate-600">
        No business settings are configurable yet. They will be added here as the related modules are built and the business rules are confirmed.
      </p>
      {auth.can('USERS', 'VIEW') && (
        <p className="mt-4 text-sm text-slate-600">
          Roles and permissions are managed under{' '}
          <Link to="/admin/users" className="font-medium text-blue-700 hover:underline">
            Users &amp; Access
          </Link>
          .
        </p>
      )}
    </Panel>
  )
}

const ORGANIZATION: SectionId[] = ['company', 'divisions', 'departments', 'holidays', 'tax']

const OVERVIEW_PARTS: Partial<Record<SectionId, { part: OverviewPart; title: string; subtitle: string }>> = {
  users: { part: 'overview', title: 'Users', subtitle: 'How many people have an account, in which state, and who is waiting for approval.' },
  access: { part: 'access', title: 'Roles & access', subtitle: 'What each role may do in each module.' },
  activity: { part: 'activity', title: 'Account activity', subtitle: 'Who signed in lately and which accounts have not been used.' },
}

export function SettingsPage() {
  const auth = useAuth()
  const [params, setParams] = useSearchParams()

  const mine: NavItem[] = [
    { id: 'profile', label: 'Profile', icon: ICONS.profile },
    { id: 'preferences', label: 'Preferences', icon: ICONS.preferences },
    { id: 'security', label: 'Security', icon: ICONS.security },
  ]
  const admin: NavItem[] = auth.can('USERS', 'VIEW')
    ? [
        { id: 'users', label: 'Users', icon: ICONS.users },
        { id: 'access', label: 'Roles & access', icon: ICONS.access },
        { id: 'activity', label: 'Account activity', icon: ICONS.activity },
      ]
    : []
  const organization: NavItem[] = [
    { id: 'company', label: 'Company profile', icon: ICONS.company },
    { id: 'divisions', label: 'Divisions', icon: ICONS.divisions },
    ...(DEPARTMENTS_ENABLED ? [{ id: 'departments' as const, label: 'Departments', icon: ICONS.departments }] : []),
    { id: 'holidays', label: 'Holidays', icon: ICONS.holidays },
    { id: 'tax', label: 'Tax setup', icon: ICONS.tax },
  ]
  const system: NavItem[] = [
    { id: 'status', label: 'System status', icon: ICONS.status },
    { id: 'business', label: 'Business settings', icon: ICONS.business },
  ]
  const groups = [{ title: 'My settings', items: mine }, ...(admin.length > 0 ? [{ title: 'Administration', items: admin }] : []), { title: 'Organization', items: organization }, { title: 'System', items: system }]
  const known = groups.flatMap((group) => group.items.map((item) => item.id))
  const wanted = params.get('section') as SectionId | null
  const section: SectionId = wanted && known.includes(wanted) ? wanted : 'profile'
  const overview = OVERVIEW_PARTS[section]

  return (
    <>
      <PageHeader title="Settings" description="Your account, how the application looks, and what administrators need to know about users and access." />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="min-w-0 lg:sticky lg:top-24 lg:self-start">
          <div className="flex gap-6 overflow-x-auto pb-1 lg:block lg:space-y-6 lg:overflow-visible">
            {groups.map((group) => (
              <div key={group.title} className="shrink-0 lg:shrink">
                <p className="mb-2 hidden px-3 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500 lg:block">{group.title}</p>
                <ul className="flex gap-1 lg:block lg:space-y-1">
                  {group.items.map((item) => {
                    const on = item.id === section

                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          aria-current={on ? 'page' : undefined}
                          onClick={() => setParams({ section: item.id }, { replace: true })}
                          className={cx(
                            'flex w-full items-center gap-3 whitespace-nowrap rounded-xl border-l-4 px-3 py-2.5 text-sm font-medium transition-all duration-150',
                            on ? 'border-[#1479BD] bg-white text-[#0b3b66] shadow-sm ring-1 ring-slate-200' : 'border-transparent text-slate-700 hover:bg-white/70 hover:text-[#0b3b66]',
                          )}
                        >
                          <span className={on ? 'text-[#1479BD]' : 'text-slate-500'}>{item.icon}</span>
                          {item.label}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        <div key={section} className="page-enter min-w-0">
          {section === 'profile' && <ProfilePanel />}
          {section === 'preferences' && <PreferencesPanel />}
          {section === 'security' && <SecurityPanel />}
          {overview && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-[#0b3b66]">{overview.title}</h2>
                <p className="mt-1 text-sm text-slate-500">{overview.subtitle}</p>
              </div>
              <UserOverview part={overview.part} />
            </div>
          )}
          {ORGANIZATION.includes(section as OrganizationSection) && <OrganizationPanel section={section as OrganizationSection} />}
          {section === 'status' && <StatusPanel />}
          {section === 'business' && <BusinessPanel />}
        </div>
      </div>
    </>
  )
}
