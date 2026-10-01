import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { useDialogBehavior } from '../components/hooks'
import { Button } from '../components/ui'
import { cx, initialsOf } from '../lib/format'
import { NAVIGATION } from './navigation'

// The width from which the sidebar is always visible (Tailwind's "lg").
const DESKTOP_QUERY = '(min-width: 1024px)'

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
    </svg>
  )
}

function Sidebar({ onNavigate, onClose }: { onNavigate: () => void; onClose?: () => void }) {
  const auth = useAuth()

  // Hiding a link is a convenience only; the API enforces every permission.
  const sections = NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => auth.can(item.module, 'VIEW')),
  })).filter((section) => section.items.length > 0)

  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-slate-900 text-slate-300">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-800 px-5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-600 text-sm font-bold text-white" aria-hidden="true">
          S
        </span>
        <span className="flex-1 text-base font-semibold tracking-wide text-white">STSLEV AMC</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="-mr-2 rounded-md p-2 text-slate-300 hover:bg-slate-800 hover:text-white focus-visible:outline-white"
          >
            <CloseIcon />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        {sections.length === 0 && <p className="px-3 text-sm text-slate-400">No modules are available for your role.</p>}

        {sections.map((section) => (
          <div key={section.title ?? 'top'} className="mb-5">
            {section.title && <h2 className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{section.title}</h2>}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cx(
                        'block rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-white',
                        isActive ? 'bg-blue-700 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  )
}

/** The sidebar as a slide-over on screens too narrow to keep it visible. */
function MobileMenu({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null)

  useDialogBehavior(panelRef, onClose, 'a[aria-current="page"]')

  // Widening the window brings the permanent sidebar back, so the slide-over must go.
  useEffect(() => {
    const desktop = window.matchMedia?.(DESKTOP_QUERY)

    if (!desktop) {
      return
    }

    const onChange = () => {
      if (desktop.matches) {
        onClose()
      }
    }

    desktop.addEventListener('change', onChange)
    return () => desktop.removeEventListener('change', onChange)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      <div className="absolute inset-0 bg-slate-900/60" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        tabIndex={-1}
        className="relative h-full w-72 max-w-[85vw] shadow-xl outline-none"
      >
        <Sidebar onNavigate={onClose} onClose={onClose} />
      </div>
    </div>
  )
}

/** Where the current page sits in the navigation, for the header. */
function currentLocation(pathname: string): { section: string | null; label: string } | null {
  if (pathname === '/account') {
    return { section: null, label: 'My Account' }
  }

  for (const section of NAVIGATION) {
    for (const item of section.items) {
      if (pathname === item.path || pathname.startsWith(`${item.path}/`)) {
        return { section: section.title, label: item.label }
      }
    }
  }

  return null
}

export function AppLayout() {
  const auth = useAuth()
  const { pathname } = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const shownPath = useRef(pathname)

  // A new page starts at the top, with keyboard focus at the start of its content.
  useEffect(() => {
    if (shownPath.current === pathname) {
      return
    }

    shownPath.current = pathname
    document.documentElement.scrollTop = 0
    mainRef.current?.focus({ preventScroll: true })
  }, [pathname])

  const fullName = auth.user?.fullName ?? ''
  const roleNames = auth.user?.roles.map((role) => role.name).join(', ') || 'No role assigned'
  const location = currentLocation(pathname)

  return (
    <div className="min-h-screen lg:pl-64">
      <a
        href="#main-content"
        className="sr-only rounded-md bg-white px-4 py-2 text-sm font-medium text-blue-800 shadow-lg focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50"
      >
        Skip to main content
      </a>

      {/* Desktop sidebar */}
      <div className="fixed inset-y-0 left-0 hidden w-64 lg:block">
        <Sidebar onNavigate={() => {}} />
      </div>

      {/* Mobile sidebar */}
      {menuOpen && <MobileMenu onClose={() => setMenuOpen(false)} />}

      <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <button
            type="button"
            className="-ml-2 rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            aria-label="Open menu"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
            </svg>
          </button>
          <span className="whitespace-nowrap text-base font-semibold text-slate-900 lg:hidden">STSLEV AMC</span>
          {location && (
            <p className="hidden truncate text-sm text-slate-500 lg:block">
              {location.section && (
                <>
                  {location.section}
                  <span className="mx-2 text-slate-300" aria-hidden="true">
                    /
                  </span>
                </>
              )}
              <span className="font-medium text-slate-700">{location.label}</span>
            </p>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Link
            to="/account"
            aria-label={`My account: ${fullName}, ${roleNames}`}
            title="My account"
            className="flex min-w-0 items-center gap-2.5 rounded-md p-1 hover:bg-slate-100 sm:px-2"
          >
            <span className="min-w-0 text-right max-sm:hidden">
              <span className="block truncate text-sm font-medium leading-tight text-slate-900">{fullName}</span>
              <span className="block truncate text-xs leading-tight text-slate-500">{roleNames}</span>
            </span>
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700"
              aria-hidden="true"
            >
              {initialsOf(fullName)}
            </span>
          </Link>
          <Button variant="secondary" size="sm" className="shrink-0 whitespace-nowrap" onClick={auth.logout}>
            Sign out
          </Button>
        </div>
      </header>

      <main id="main-content" ref={mainRef} tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6 outline-none sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  )
}
