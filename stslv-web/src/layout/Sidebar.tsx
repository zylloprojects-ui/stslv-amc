import { useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { cx } from '../lib/format'
import type { Theme } from '../lib/preferences'
import { NAVIGATION } from './navigation'

type IconKey = 'panel-close' | 'panel-open' | 'moon' | 'sun' | 'dashboard' | 'Operations' | 'Finance' | 'Reporting' | 'Administration' | 'settings' | 'logout'

const NAV_ICONS: Record<IconKey, ReactNode> = {
  'panel-close': (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15M16 9.5l-2.5 2.5 2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  'panel-open': (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15M13 9.5l2.5 2.5-2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" strokeLinejoin="round" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" strokeLinecap="round" />
    </>
  ),
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
    </>
  ),
  Operations: (
    <>
      <rect x="3.5" y="7" width="17" height="12.5" rx="2.5" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17" strokeLinecap="round" />
    </>
  ),
  Finance: (
    <path
      d="M12 3v18M16.5 7.5c-.6-1.4-2.3-2.2-4.5-2.2-2.5 0-4 1.1-4 2.8 0 4 9 1.7 9 6 0 1.8-1.7 3-4.5 3-2.3 0-4.1-.9-4.7-2.5"
      strokeLinecap="round"
    />
  ),
  Reporting: <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" strokeLinecap="round" />,
  Administration: (
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
  logout: <path d="M9 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H9M15 8l4 4-4 4M19 12H9" strokeLinecap="round" strokeLinejoin="round" />,
}

function NavIcon({ name }: { name: IconKey }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      {NAV_ICONS[name]}
    </svg>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={cx('ml-auto h-4 w-4 shrink-0 transition-transform duration-200', open ? 'rotate-90' : '')}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m7 4 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const TOP_LEVEL = 'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200'
const TOP_IDLE = 'sb-idle'
const TOP_ACTIVE = 'bg-gradient-to-r from-[#1479BD] to-[#0E93B5] text-white shadow-md shadow-sky-900/40'

interface SidebarProps {
  onNavigate: () => void
  /** Icon-only mode (desktop). */
  collapsed?: boolean
  /** Called when a collapsed group is clicked, to open the sidebar again. */
  onExpand?: () => void
  theme: Theme
  onToggleTheme: () => void
  /** Desktop only: minimise or expand the sidebar. */
  onToggleCollapse?: () => void
}

export function Sidebar({ onNavigate, collapsed = false, onExpand, theme, onToggleTheme, onToggleCollapse }: SidebarProps) {
  const auth = useAuth()
  const location = useLocation()
  // One group open at a time (accordion). The group holding the current page starts open.
  const [openGroup, setOpenGroup] = useState<string | null>(() => NAVIGATION.find((section) => section.title && section.items.some((item) => location.pathname.startsWith(item.path)))?.title ?? null)

  // Hiding a link is a convenience only; the API enforces every permission.
  // Settings is shown in the footer instead of the Administration group.
  const settingsAllowed = auth.can('SETTINGS', 'VIEW')
  const sections = NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.module !== 'SETTINGS' && auth.can(item.module, 'VIEW')),
  })).filter((section) => section.items.length > 0)

  const topLevel = (...extra: (string | false)[]) => cx(TOP_LEVEL, collapsed && 'justify-center px-0', ...extra)
  const label = (text: string) => <span className={collapsed ? 'sr-only' : undefined}>{text}</span>

  return (
    <nav aria-label="Main" className="app-sidebar relative flex h-full flex-col overflow-hidden">
      <span className="login-float pointer-events-none absolute -left-16 top-1/3 h-48 w-48 rounded-full bg-[#1B8AD3] opacity-20 blur-3xl" aria-hidden="true" />
      <span className="login-float pointer-events-none absolute -bottom-10 -right-16 h-48 w-48 rounded-full bg-[#5BAF48] opacity-15 blur-3xl [animation-delay:-6s]" aria-hidden="true" />

      <div
        className={cx(
          'sb-line-b relative flex shrink-0 items-center',
          collapsed ? 'flex-col justify-center gap-2 px-2 py-3' : 'h-20 gap-3 px-4',
        )}
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white shadow-lg shadow-black/30">
          <img src="/stslv-logo.png" alt="" className="h-9 w-9 object-contain" />
        </span>
        <div className={cx('min-w-0 flex-1 leading-tight', collapsed && 'hidden')}>
          <span className="block truncate sb-strong text-lg font-bold tracking-wide">STSLEV AMC</span>
          <span className="sb-muted block text-xs">ERP System</span>
        </div>
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-pressed={collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Minimise sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Minimise sidebar'}
            className="flex h-8 w-8 shrink-0 items-center justify-center sb-idle rounded-lg transition-colors"
          >
            <NavIcon name={collapsed ? 'panel-open' : 'panel-close'} />
          </button>
        )}
      </div>

      <div className="sidebar-scroll relative flex-1 overflow-y-auto px-3 py-3">
        {sections.length === 0 && <p className="sb-muted px-3 text-sm">No modules are available for your role.</p>}

        {sections.map((section) => {
          const title = section.title
          const open = openGroup === title

          // Ungrouped items (Dashboard) are plain top-level links.
          if (!title) {
            return (
              <ul key="top" className="mb-1 space-y-0.5">
                {section.items.map((item) => (
                  <li key={item.path}>
                    <NavLink to={item.path} onClick={onNavigate} title={collapsed ? item.label : undefined} className={({ isActive }) => topLevel(isActive ? TOP_ACTIVE : TOP_IDLE)}>
                      <NavIcon name="dashboard" />
                      {label(item.label)}
                    </NavLink>
                  </li>
                ))}
              </ul>
            )
          }

          return (
            <div key={title} className="mb-1">
              <h2>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => (collapsed ? onExpand?.() : setOpenGroup(open ? null : title))}
                  title={collapsed ? title : undefined}
                  className={topLevel(TOP_IDLE)}
                >
                  <NavIcon name={title as IconKey} />
                  {label(title)}
                  {!collapsed && <Chevron open={open} />}
                </button>
              </h2>
              {open && !collapsed && (
                <ul className="login-rise ml-[1.35rem] mt-0.5 space-y-0.5 sb-line-l pl-3">
                  {section.items.map((item) => (
                    <li key={item.path}>
                      <NavLink
                        to={item.path}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cx(
                            'block rounded-lg px-3 py-1.5 text-[13px] font-medium transition-all duration-200',
                            isActive ? TOP_ACTIVE : 'sb-idle hover:translate-x-0.5',
                          )
                        }
                      >
                        {item.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      <div className="sb-line-t relative shrink-0 space-y-0.5 px-3 py-3">
        <button type="button" onClick={onToggleTheme} aria-pressed={theme === 'dark'} title={collapsed ? 'Dark Mode' : undefined} className={topLevel(TOP_IDLE)}>
          <NavIcon name={theme === 'dark' ? 'sun' : 'moon'} />
          {label(theme === 'dark' ? 'Light Mode' : 'Dark Mode')}
        </button>
        {settingsAllowed && (
          <NavLink to="/settings" onClick={onNavigate} title={collapsed ? 'Settings' : undefined} className={({ isActive }) => topLevel(isActive ? TOP_ACTIVE : TOP_IDLE)}>
            <NavIcon name="settings" />
            {label('Settings')}
          </NavLink>
        )}
        <button type="button" onClick={auth.logout} title={collapsed ? 'Sign Out' : undefined} className={topLevel(TOP_IDLE)}>
          <NavIcon name="logout" />
          {label('Sign Out')}
        </button>
      </div>
    </nav>
  )
}
