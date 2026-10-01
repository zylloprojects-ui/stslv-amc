import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { usePalette, useSidebarCollapsed, useTheme } from '../lib/preferences'
import { CookieNotice } from './CookieNotice'
import { FeedbackButton } from './FeedbackWidget'
import { HeaderSearch } from './HeaderSearch'
import { PaletteMenu } from './PaletteMenu'
import { ScrollToTop } from './ScrollToTop'
import { Sidebar } from './Sidebar'
import { SplashLoader } from './SplashLoader'
import { UserMenu } from './UserMenu'

export function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, toggleCollapsed, setCollapsed] = useSidebarCollapsed()
  const [theme, toggleTheme] = useTheme()
  const [palette, choosePalette] = usePalette()

  return (
    <div className={`min-h-screen transition-[padding] duration-300 ${collapsed ? 'lg:pl-[4.5rem]' : 'lg:pl-64'}`}>
      {/* Desktop sidebar */}
      <div className={`fixed inset-y-0 left-0 z-40 hidden transition-[width] duration-300 lg:block ${collapsed ? 'w-[4.5rem]' : 'w-64'}`}>
        <Sidebar onNavigate={() => {}} collapsed={collapsed} onExpand={() => setCollapsed(false)} onToggleCollapse={toggleCollapsed} theme={theme} onToggleTheme={toggleTheme} />

      </div>

      {/* Mobile sidebar */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-slate-900/60" onClick={() => setMenuOpen(false)} />
          <div className="relative h-full w-64 shadow-xl">
            <Sidebar onNavigate={() => setMenuOpen(false)} theme={theme} onToggleTheme={toggleTheme} />
          </div>
        </div>
      )}

      <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 bg-white/90 px-4 shadow-sm backdrop-blur sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
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
          <span className="flex items-center gap-2 whitespace-nowrap text-base font-semibold text-[#0b3b66] md:hidden">
            <img src="/stslv-logo.png" alt="" className="h-7 w-7 object-contain" />
            STSLEV AMC
          </span>
          <HeaderSearch />
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <FeedbackButton />
          <PaletteMenu palette={palette} onChoose={choosePalette} dark={theme === 'dark'} />
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            className="shrink-0 rounded-full p-2 text-slate-600 transition-colors hover:bg-sky-50"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              {theme === 'dark' ? (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" strokeLinecap="round" />
                </>
              ) : (
                <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" strokeLinejoin="round" />
              )}
            </svg>
          </button>
          <UserMenu />
        </div>
        <span className="login-gradient pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-gradient-to-r from-[#F5C622] via-[#D1428C] via-35% via-[#1B8AD3] to-[#5BAF48]" aria-hidden="true" />
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>

      <ScrollToTop />
      <CookieNotice />
      <SplashLoader />
    </div>
  )
}
