import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useDialogBehavior } from '../components/hooks'
import { cx } from '../lib/format'
import { usePalette, useSidebarCollapsed, useTheme, type Theme } from '../lib/preferences'
import { CookieNotice } from './CookieNotice'
import { FeedbackButton } from './FeedbackWidget'
import { HeaderSearch } from './HeaderSearch'
import { PaletteMenu } from './PaletteMenu'
import { ScrollToTop } from './ScrollToTop'
import { SelectPopup } from './SelectPopup'
import { Sidebar } from './Sidebar'
import { SplashLoader } from './SplashLoader'
import { UserMenu } from './UserMenu'

// The width from which the sidebar is always visible (Tailwind's "lg").
const DESKTOP_QUERY = '(min-width: 1024px)'

/** The sidebar as a slide-over on screens too narrow to keep it visible. */
function MobileMenu({ onClose, theme, onToggleTheme }: { onClose: () => void; theme: Theme; onToggleTheme: () => void }) {
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
        className="relative h-full w-64 max-w-[85vw] shadow-xl outline-none"
      >
        <Sidebar onNavigate={onClose} onClose={onClose} theme={theme} onToggleTheme={onToggleTheme} />
      </div>
    </div>
  )
}

export function AppLayout() {
  const { pathname } = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, toggleCollapsed, setCollapsed] = useSidebarCollapsed()
  const [theme, toggleTheme] = useTheme()
  const [palette, choosePalette] = usePalette()
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

  return (
    <div className={cx('min-h-screen transition-[padding] duration-300', collapsed ? 'lg:pl-[4.5rem]' : 'lg:pl-64')}>
      <a
        href="#main-content"
        className="sr-only rounded-md bg-white px-4 py-2 text-sm font-medium text-blue-800 shadow-lg focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50"
      >
        Skip to main content
      </a>

      {/* Desktop sidebar */}
      <div className={cx('fixed inset-y-0 left-0 z-40 hidden transition-[width] duration-300 lg:block', collapsed ? 'w-[4.5rem]' : 'w-64')}>
        <Sidebar
          onNavigate={() => {}}
          collapsed={collapsed}
          onExpand={() => setCollapsed(false)}
          onToggleCollapse={toggleCollapsed}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      </div>

      {/* Mobile sidebar */}
      {menuOpen && <MobileMenu onClose={() => setMenuOpen(false)} theme={theme} onToggleTheme={toggleTheme} />}

      <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-slate-200/70 bg-white/80 px-4 shadow-[0_1px_0_rgba(255,255,255,0.6),0_6px_20px_-12px_rgba(15,23,42,0.18)] backdrop-blur-xl sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <button
            type="button"
            className="rounded-md p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            aria-label="Open menu"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
            </svg>
          </button>
          <span className="flex items-center gap-2 whitespace-nowrap text-base font-semibold text-[#0b3b66] md:hidden">
            <img src="/stslv-logo.png" alt="" className="h-7 w-7 object-contain" />
            <span className="max-[430px]:sr-only">STSLEV AMC</span>
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
      </header>

      {/* The loader covers the page content only, never the sidebar or the header. */}
      <div className="relative min-h-[calc(100vh-4rem)]">
        <main id="main-content" ref={mainRef} tabIndex={-1} className="mx-auto max-w-[92rem] px-4 py-5 outline-none sm:px-6 sm:py-7 lg:px-5 xl:px-6">
          <div key={pathname} className="page-enter">
            <Outlet />
          </div>
        </main>
        <SplashLoader />
      </div>

      <SelectPopup />
      <ScrollToTop />
      <CookieNotice />
    </div>
  )
}
