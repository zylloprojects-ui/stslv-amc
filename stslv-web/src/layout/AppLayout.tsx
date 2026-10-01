import { useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { Button } from '../components/ui'
import { cx } from '../lib/format'
import { NAVIGATION } from './navigation'

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const auth = useAuth()

  // Hiding a link is a convenience only; the API enforces every permission.
  const sections = NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => auth.can(item.module, 'VIEW')),
  })).filter((section) => section.items.length > 0)

  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-slate-900 text-slate-300">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-800 px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-600 text-sm font-bold text-white" aria-hidden="true">
          S
        </span>
        <span className="text-base font-semibold tracking-wide text-white">STSLV AMC</span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        {sections.length === 0 && <p className="px-3 text-sm text-slate-400">No modules are available for your role.</p>}

        {sections.map((section) => (
          <div key={section.title ?? 'top'} className="mb-5">
            {section.title && (
              <h2 className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{section.title}</h2>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cx(
                        'block rounded-md px-3 py-2 text-sm font-medium',
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

export function AppLayout() {
  const auth = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)

  const roleNames = auth.user?.roles.map((role) => role.name).join(', ') || 'No role assigned'

  return (
    <div className="min-h-screen lg:pl-64">
      {/* Desktop sidebar */}
      <div className="fixed inset-y-0 left-0 hidden w-64 lg:block">
        <Sidebar onNavigate={() => {}} />
      </div>

      {/* Mobile sidebar */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-slate-900/60" onClick={() => setMenuOpen(false)} />
          <div className="relative h-full w-64 shadow-xl">
            <Sidebar onNavigate={() => setMenuOpen(false)} />
          </div>
        </div>
      )}

      <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-6">
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            className="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
            </svg>
          </button>
          <span className="whitespace-nowrap text-base font-semibold text-slate-900 lg:hidden">STSLV AMC</span>
        </div>

        <div className="flex min-w-0 items-center gap-3">
          <Link to="/account" className="min-w-0 rounded-md px-2 py-1 text-right hover:bg-slate-100" title="My account">
            <span className="block truncate text-sm font-medium leading-tight text-slate-900">{auth.user?.fullName}</span>
            <span className="block truncate text-xs leading-tight text-slate-500">{roleNames}</span>
          </Link>
          <Button variant="secondary" size="sm" className="shrink-0 whitespace-nowrap" onClick={auth.logout}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  )
}
