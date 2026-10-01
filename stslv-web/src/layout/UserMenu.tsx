import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context'

function MenuIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      {children}
    </svg>
  )
}

const ITEM = 'flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-sky-50'

/** Signed-in user's profile menu: account details, shortcuts and sign out. */
export function UserMenu() {
  const auth = useAuth()
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    function onPointerDown(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const user = auth.user
  const roles = user?.roles.map((role) => role.name) ?? []
  const initials = (user?.fullName ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-1 transition-colors hover:bg-sky-50"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#1B8AD3] to-[#5BAF48] text-sm font-bold text-white" aria-hidden="true">
          {initials}
        </span>
        <span className="hidden min-w-0 text-left sm:block">
          <span className="block max-w-40 truncate text-sm font-semibold leading-tight text-slate-900">{user?.fullName}</span>
          <span className="block max-w-40 truncate text-xs leading-tight text-slate-500">{roles.join(', ') || 'No role assigned'}</span>
        </span>
        <svg viewBox="0 0 20 20" className={`hidden h-4 w-4 text-slate-400 transition-transform duration-200 sm:block ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m5 8 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="login-rise absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl" role="group" aria-label="Account menu">
          <span className="block h-1 bg-gradient-to-r from-[#1B8AD3] via-[#5BAF48] via-50% to-[#F5C622]" aria-hidden="true" />
          <div className="px-4 py-3.5">
            <p className="text-[15px] font-semibold text-slate-900">{user?.fullName}</p>
            <p className="mt-0.5 break-all text-xs text-slate-500">{user?.email}</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {roles.map((role) => (
                <span key={role} className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-[#0b5d8f]">
                  {role}
                </span>
              ))}
            </div>
          </div>

          <div className="border-t border-slate-200 py-1">
            <Link to="/account" onClick={() => setOpen(false)} className={ITEM}>
              <MenuIcon>
                <circle cx="12" cy="8" r="3.5" />
                <path d="M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5" strokeLinecap="round" />
              </MenuIcon>
              My Profile
            </Link>
            {auth.can('DASHBOARD', 'VIEW') && (
              <Link to="/dashboard" onClick={() => setOpen(false)} className={ITEM}>
                <MenuIcon>
                  <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
                  <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
                  <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
                  <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
                </MenuIcon>
                Dashboard
              </Link>
            )}
            {auth.can('USERS', 'VIEW') && (
              <Link to="/admin/users" onClick={() => setOpen(false)} className={ITEM}>
                <MenuIcon>
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 3v2.2M12 18.8V21M4.6 7.5l1.9 1.1M17.5 15.4l1.9 1.1M4.6 16.5l1.9-1.1M17.5 8.6l1.9-1.1" strokeLinecap="round" />
                </MenuIcon>
                Manage Users
              </Link>
            )}
          </div>

          <div className="border-t border-slate-200 py-1">
            <button type="button" onClick={auth.logout} className={`${ITEM} font-medium !text-red-600 hover:!bg-red-50`}>
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M9 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H9M15 8l4 4-4 4M19 12H9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
